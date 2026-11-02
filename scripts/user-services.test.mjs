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
  const deadline = Number(/SECONDS\s*\+\s*(\d+)/u.exec(probe)?.[1]);

  let budgetSeconds;
  if (Number.isInteger(retry) && Number.isInteger(retryDelay)) {
    assert.ok(retry > 0 && retryDelay > 0, 'readiness probe must set a positive --retry and --retry-delay');
    budgetSeconds = retry * retryDelay;
  } else if (Number.isInteger(deadline) && deadline > 0) {
    budgetSeconds = deadline;
  } else {
    assert.fail(`readiness probe must state its wait budget with --retry or SECONDS + N: ${probe}`);
  }

  return { probe, budgetSeconds, feedsWatchdog: probe.includes('systemd-notify WATCHDOG=1') };
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

for (const [unitName, endpoint] of [
  ['unified-mpc-mcp-http.service', '/_unified-mpc/identity'],
  ['unified-mpc-web.service', '/_unified-mpc/ready'],
]) {
  test(`${unitName} tolerates a cold runtime start before failing readiness`, async () => {
    const unitText = await readUnit(unitName);
    const probe = readinessProbe(unitText, endpoint);
    const timeoutStart = timeoutStartSeconds(unitText);

    assert.ok(probe.probe.includes(endpoint), `readiness probe must target ${endpoint}`);
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
    const watchdog = watchdogSeconds(unitText);
    if (watchdog !== undefined) {
      assert.ok(
        probe.feedsWatchdog || watchdog > probe.budgetSeconds,
        `the ${String(probe.budgetSeconds)}s readiness probe must feed WATCHDOG=1 or fit inside WatchdogSec=${String(watchdog)}`,
      );
    }
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
