import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A fresh build starts on a cold Node compile cache and still runs workspace
 * admission before the listener binds. The host measured 24-40 s, so the probe
 * must tolerate at least this budget instead of the historical 30 s.
 */
const MIN_READINESS_BUDGET_SECONDS = 90;

async function readUnit(name) {
  return readFile(path.join(ROOT, 'scripts', name), 'utf8');
}

/**
 * A deadline probe is a bounded shell loop:
 * `deadline=$((SECONDS + N)); while ...; do <body>; done; exit M`.
 * The body must ping the watchdog and end with a non-zero timeout exit, so a
 * start that never becomes ready fails instead of looking successful.
 */
function deadlineLoop(probe) {
  const match = /deadline=\$\(\(SECONDS \+ (\d+)\)\); while \[ "\$SECONDS" -lt "\$deadline" \]; do (.+); done; exit (\d+)/u.exec(probe);
  if (match === null) return undefined;
  return { deadline: Number(match[1]), body: match[2], exitCode: Number(match[3]) };
}

/**
 * Read the readiness probe for `endpoint`. A probe is either a `curl --retry N
 * --retry-delay D` line or a bounded shell loop (`SECONDS + N`); both state the
 * wall-clock budget they will spend waiting for the listener.
 */
function readinessProbe(unitText, endpoint) {
  const probes = unitText
    .split('\n')
    .filter((line) => line.startsWith('ExecStartPost='))
    .filter((line) => line.includes(endpoint));

  assert.equal(probes.length, 1, `each unit must have exactly one ${endpoint} readiness probe`);
  const probe = probes[0];

  const retry = Number(/--retry\s+(\d+)/u.exec(probe)?.[1]);
  const retryDelay = Number(/--retry-delay\s+(\d+)/u.exec(probe)?.[1]);
  const loop = deadlineLoop(probe);

  let budgetSeconds;
  if (Number.isInteger(retry) && Number.isInteger(retryDelay)) {
    assert.ok(retry > 0 && retryDelay > 0, 'readiness probe must set a positive --retry and --retry-delay');
    budgetSeconds = retry * retryDelay;
  } else if (loop !== undefined) {
    assert.ok(loop.deadline > 0, 'a deadline probe must wait for a positive number of seconds');
    assert.notEqual(loop.exitCode, 0, 'a probe that runs out of time must exit non-zero so the start fails');
    budgetSeconds = loop.deadline;
  } else {
    assert.fail(`readiness probe must state its wait budget with --retry or SECONDS + N: ${probe}`);
  }

  const feedsWatchdog = loop !== undefined && loop.body.includes('systemd-notify WATCHDOG=1');

  return { probe, budgetSeconds, loop, feedsWatchdog };
}

function timeoutStartSeconds(unitText) {
  const value = Number(/^TimeoutStartSec=(\d+)$/mu.exec(unitText)?.[1]);
  assert.ok(Number.isInteger(value) && value > 0, 'unit must set a positive integer TimeoutStartSec');
  return value;
}

function watchdogSeconds(unitText) {
  const match = /^WatchdogSec=(\d+)$/mu.exec(unitText);
  return match === null ? undefined : Number(match[1]);
}

function durationSeconds(unitText, key) {
  const match = new RegExp(`^${key}=(\\d+)(min|s|ms)?$`, 'mu').exec(unitText);
  if (match === null) return undefined;
  const value = Number(match[1]);
  if (match[2] === 'min') return value * 60;
  if (match[2] === 'ms') return value / 1000;
  return value;
}

for (const [unitName, endpoint] of [
  ['unified-mpc-mcp-http.service', '/_unified-mpc/identity'],
  ['unified-mpc-web.service', '/_unified-mpc/ready'],
]) {
  test(`${unitName} tolerates a cold runtime start before failing readiness`, async () => {
    const unitText = await readUnit(unitName);
    const probe = readinessProbe(unitText, endpoint);
    const timeoutStart = timeoutStartSeconds(unitText);
    const restartSec = durationSeconds(unitText, 'RestartSec');
    const watchdog = watchdogSeconds(unitText);

    assert.ok(
      probe.budgetSeconds >= MIN_READINESS_BUDGET_SECONDS,
      `readiness budget ${String(probe.budgetSeconds)}s must be at least ${String(MIN_READINESS_BUDGET_SECONDS)}s`,
    );
    assert.ok(
      timeoutStart > probe.budgetSeconds,
      `TimeoutStartSec ${String(timeoutStart)}s must exceed the ${String(probe.budgetSeconds)}s readiness budget`,
    );
    assert.match(unitText, /^RestartPreventExitStatus=78$/mu, 'unrecoverable configuration must not restart forever');

    // systemd arms WatchdogSec as soon as the service starts, so it runs while
    // ExecStartPost waits for the listener. A probe that stays quiet for its
    // whole budget is killed long before that budget ends (#587 review).
    if (watchdog !== undefined) {
      assert.ok(
        probe.feedsWatchdog || watchdog > probe.budgetSeconds,
        `the ${String(probe.budgetSeconds)}s readiness probe must feed WATCHDOG=1 or fit inside WatchdogSec=${String(watchdog)}`,
      );
      if (probe.feedsWatchdog) {
        const loop = probe.loop;
        assert.ok(loop !== undefined, 'a watchdog-fed probe must be a deadline loop');
        assert.ok(
          loop.body.indexOf('systemd-notify WATCHDOG=1') < loop.body.indexOf('/usr/bin/curl'),
          'the probe must ping WATCHDOG=1 before each attempt, not only after one succeeds',
        );
        const pause = Number(/\/usr\/bin\/sleep\s+(\d+)/u.exec(loop.body)?.[1]);
        assert.ok(Number.isInteger(pause) && pause > 0, 'the probe loop must pause between attempts');
        assert.ok(
          pause * 3 <= watchdog,
          `a ${String(pause)}s pause between pings is too long for WatchdogSec=${String(watchdog)}`,
        );
      }
    }

    // A failed readiness costs one probe budget plus RestartSec. If the start
    // limit window is shorter than the burst times that cycle, the window
    // resets before the limit can ever be reached and the unit restarts forever.
    const interval = durationSeconds(unitText, 'StartLimitIntervalSec');
    const burst = Number(/^StartLimitBurst=(\d+)$/mu.exec(unitText)?.[1]);
    assert.ok(
      Number.isInteger(burst) && burst > 0,
      'unit must set a positive StartLimitBurst so a permanent failure eventually stops',
    );
    assert.ok(
      interval !== undefined && interval > 0,
      'unit must set StartLimitIntervalSec so a permanent failure eventually stops',
    );
    assert.ok(Number.isInteger(restartSec) && restartSec >= 0, 'unit must set RestartSec');
    const failedCycle = probe.budgetSeconds + restartSec;
    assert.ok(
      interval > burst * failedCycle,
      `StartLimitIntervalSec=${String(interval)}s must exceed ${String(burst)} failed starts of ~${String(failedCycle)}s, otherwise the limit is unreachable`,
    );
  });
}

test('the web probe feeds the watchdog it can outlive', async () => {
  const unitText = await readUnit('unified-mpc-web.service');
  const probe = readinessProbe(unitText, '/_unified-mpc/ready');
  const watchdog = watchdogSeconds(unitText);

  assert.ok(watchdog !== undefined, 'the web unit relies on WatchdogSec for runtime supervision');
  assert.ok(probe.budgetSeconds > watchdog, 'the readiness probe outlives the watchdog window');
  assert.equal(probe.feedsWatchdog, true, 'the probe must ping WATCHDOG=1 while it waits');
});
