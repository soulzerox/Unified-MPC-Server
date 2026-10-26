import { readdir, readFile, statfs } from 'node:fs/promises';
import os from 'node:os';

export interface HostCpuMetrics {
  readonly cores: number;
  readonly model: string;
  readonly load1: number;
  readonly load5: number;
  readonly load15: number;
  readonly usagePercent: number | null;
}

export interface HostMemoryMetrics {
  readonly totalBytes: number;
  readonly usedBytes: number;
  readonly availableBytes: number;
}

export interface HostSwapDevice {
  readonly name: string;
  readonly type: string;
  readonly sizeBytes: number;
  readonly usedBytes: number;
  readonly priority: number;
}

export interface HostZramDevice {
  readonly name: string;
  readonly algorithm: string;
  readonly diskSizeBytes: number;
  readonly originalBytes: number;
  readonly compressedBytes: number;
  readonly memoryUsedBytes: number;
}

export interface HostDiskMetrics {
  readonly mount: string;
  readonly totalBytes: number;
  readonly usedBytes: number;
  readonly availableBytes: number;
  readonly usedPercent: number;
}

export interface HostProcessEntry {
  readonly pid: number;
  readonly name: string;
  /** Share of one CPU core (100 = one saturated core), like `top`'s default Irix mode. */
  readonly cpuPercent: number;
  readonly memoryBytes: number;
  readonly memoryPercent: number;
}

export interface HostProcessMetrics {
  readonly total: number;
  /** Heaviest processes since the previous snapshot, already truncated for display. */
  readonly topCpu: readonly HostProcessEntry[];
  /** Largest resident sets, already truncated for display. */
  readonly topMemory: readonly HostProcessEntry[];
}

/** Pre-formatted one-line strings so dashboard widgets (e.g. Homepage customapi) need no client-side math. */
export interface HostDisplayMetrics {
  readonly cpu: string;
  readonly cpu_load: string;
  readonly cpu_temp: string;
  readonly memory: string;
  readonly swap: string;
  readonly disk: string;
  readonly zram: string;
  readonly uptime: string;
  readonly top_cpu: string;
  readonly top_ram: string;
  /** Per-mount strings, keyed `disk_<mount>` (e.g. `disk_root`, `disk_data`). */
  readonly [diskField: string]: string;
}

export interface HostDiskEntry extends HostDiskMetrics {
  readonly device: string;
  readonly fsType: string;
  /** Stable widget-friendly alias derived from the mount point: `/` -> `root`, `/data` -> `data`. */
  readonly key: string;
  readonly display: string;
}

export interface HostMetricsSnapshot {
  readonly hostname: string;
  readonly platform: string;
  readonly release: string;
  readonly uptimeSeconds: number;
  readonly collectedAt: string;
  readonly cpu: HostCpuMetrics;
  readonly memory: HostMemoryMetrics;
  readonly swap: {
    readonly totalBytes: number;
    readonly usedBytes: number;
    readonly devices: readonly HostSwapDevice[];
  };
  readonly zram: {
    readonly enabled: boolean;
    readonly devices: readonly HostZramDevice[];
  };
  readonly disk: HostDiskMetrics;
  readonly disks: readonly HostDiskEntry[];
  readonly processes: HostProcessMetrics;
  readonly display: HostDisplayMetrics;
}

let previousCpuSample: { readonly idle: number; readonly total: number } | null = null;

function cpuTimes(): { readonly idle: number; readonly total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idle, total };
}

// Prime the delta so the first dashboard poll reports usage instead of null.
previousCpuSample = cpuTimes();

function cpuUsagePercent(): number | null {
  const current = cpuTimes();
  const previous = previousCpuSample;
  previousCpuSample = current;
  if (previous === null) return null;
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  if (totalDelta <= 0) return null;
  const usage = (1 - idleDelta / totalDelta) * 100;
  return Math.round(Math.min(100, Math.max(0, usage)) * 10) / 10;
}

async function readMemInfo(): Promise<{ readonly total: number; readonly available: number }> {
  const text = await readFile('/proc/meminfo', 'utf8');
  const values = new Map<string, number>();
  for (const line of text.split('\n')) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const kib = Number.parseInt(line.slice(separator + 1).trim(), 10);
    if (Number.isFinite(kib)) values.set(line.slice(0, separator), kib * 1024);
  }
  return {
    total: values.get('MemTotal') ?? os.totalmem(),
    available: values.get('MemAvailable') ?? os.freemem(),
  };
}

async function readSwapDevices(): Promise<readonly HostSwapDevice[]> {
  try {
    const text = await readFile('/proc/swaps', 'utf8');
    const devices: HostSwapDevice[] = [];
    for (const line of text.split('\n').slice(1)) {
      const [name, type, sizeKib, usedKib, priority] = line.trim().split(/\s+/);
      if (name === undefined || type === undefined) continue;
      const size = Number.parseInt(sizeKib ?? '', 10);
      const used = Number.parseInt(usedKib ?? '', 10);
      devices.push({
        name,
        type,
        sizeBytes: Number.isFinite(size) ? size * 1024 : 0,
        usedBytes: Number.isFinite(used) ? used * 1024 : 0,
        priority: Number.parseInt(priority ?? '', 10) || 0,
      });
    }
    return devices;
  } catch {
    return [];
  }
}

async function readZramDevices(): Promise<readonly HostZramDevice[]> {
  let entries: string[];
  try {
    entries = await readdir('/sys/block');
  } catch {
    return [];
  }
  const devices: HostZramDevice[] = [];
  for (const entry of entries.filter((name) => name.startsWith('zram')).sort()) {
    try {
      const base = `/sys/block/${entry}`;
      const [algorithm, diskSize, mmStat] = await Promise.all([
        readFile(`${base}/comp_algorithm`, 'utf8'),
        readFile(`${base}/disksize`, 'utf8'),
        readFile(`${base}/mm_stat`, 'utf8'),
      ]);
      // mm_stat: orig_data_size compr_data_size mem_used_total mem_limit ...
      const [original, compressed, memoryUsed] = mmStat.trim().split(/\s+/).map((value) => Number.parseInt(value, 10));
      devices.push({
        name: entry,
        algorithm: /\[([^\]]+)\]/.exec(algorithm)?.[1] ?? algorithm.trim(),
        diskSizeBytes: Number.parseInt(diskSize.trim(), 10) || 0,
        originalBytes: original ?? 0,
        compressedBytes: compressed ?? 0,
        memoryUsedBytes: memoryUsed ?? 0,
      });
    } catch {
      // A half-configured zram device must not blank the whole host snapshot.
    }
  }
  return devices;
}

async function readCpuTemp(): Promise<number | null> {
  try {
    const zones = await readdir('/sys/class/thermal');
    for (const zone of zones.filter((name) => name.startsWith('thermal_zone')).sort()) {
      try {
        const [type, temp] = await Promise.all([
          readFile(`/sys/class/thermal/${zone}/type`, 'utf8'),
          readFile(`/sys/class/thermal/${zone}/temp`, 'utf8'),
        ]);
        const celsius = Number.parseInt(temp.trim(), 10) / 1000;
        if (/x86_pkg_temp|coretemp/.test(type.trim()) && Number.isFinite(celsius)) return celsius;
      } catch {
        // Skip unreadable thermal zone.
      }
    }
  } catch {
    // /sys/class/thermal not available on this host.
  }
  return null;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${Math.round(size * 10) / 10} ${units[unit]}`;
}

function formatUptime(seconds: number): string {
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function formatPercent(usedBytes: number, totalBytes: number): string {
  if (totalBytes <= 0) return '0%';
  return `${Math.round((usedBytes / totalBytes) * 1000) / 10}%`;
}

// Local block-device filesystems only: pseudo, snap and overlay mounts are noise here.
const LOCAL_DISK_FS = new Set(['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'f2fs', 'vfat', 'ntfs', 'ntfs3', 'zfs']);

function decodeMountPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function diskFieldKey(mount: string): string {
  const name = mount === '/' ? 'root' : mount.replace(/^\/+/, '');
  return name.replace(/[^a-zA-Z0-9]+/g, '_');
}

async function readMountedDisks(): Promise<readonly HostDiskEntry[]> {
  let text: string;
  try {
    text = await readFile('/proc/mounts', 'utf8');
  } catch {
    return [];
  }
  const seenDevices = new Set<string>();
  const disks: HostDiskEntry[] = [];
  for (const line of text.split('\n')) {
    const [rawDevice, rawMount, fsType] = line.trim().split(/\s+/);
    if (rawDevice === undefined || rawMount === undefined || fsType === undefined) continue;
    const device = decodeMountPath(rawDevice);
    const mount = decodeMountPath(rawMount);
    // One entry per device: bind mounts (e.g. /home/alpha/data -> /data) are the same filesystem.
    if (!LOCAL_DISK_FS.has(fsType) || !device.startsWith('/dev/') || device.startsWith('/dev/loop') || seenDevices.has(device)) continue;
    try {
      const stats = await statfs(mount);
      const totalBytes = stats.blocks * stats.bsize;
      const availableBytes = stats.bavail * stats.bsize;
      const usedBytes = totalBytes - stats.bfree * stats.bsize;
      seenDevices.add(device);
      disks.push({
        mount,
        device,
        fsType,
        key: diskFieldKey(mount),
        totalBytes,
        usedBytes,
        availableBytes,
        usedPercent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0,
        display: `${formatPercent(usedBytes, totalBytes)} of ${formatBytes(totalBytes)}`,
      });
    } catch {
      // Skip mounts that vanish mid-read (unplugged disk, lazy umount).
    }
  }
  return disks.sort((left, right) => (left.mount === '/' ? -1 : right.mount === '/' ? 1 : left.mount.localeCompare(right.mount)));
}

// Linux USER_HZ is fixed at 100 by the kernel ABI; PAGE_SIZE is 4096 on this x86_64 target.
const CLOCK_TICKS_PER_SECOND = 100;
const PAGE_SIZE_BYTES = 4096;
const PROCESS_READ_BATCH = 32;
const TOP_PROCESS_LIMIT = 3;
const PROCESS_NAME_MAX = 28;

interface ProcessStatSample {
  readonly pid: number;
  readonly name: string;
  readonly jiffies: number;
  readonly startTime: number;
  readonly memoryBytes: number;
}

interface RawProcessSample {
  readonly pid: number;
  readonly name: string;
  readonly cpuPercent: number;
  readonly memoryBytes: number;
}

interface ProcessSamplingState {
  readonly totalJiffies: number;
  readonly processes: ReadonlyMap<number, number>;
}

let previousProcessSampling: ProcessSamplingState | null = null;

async function readTotalCpuJiffies(): Promise<number> {
  try {
    const text = await readFile('/proc/stat', 'utf8');
    const line = text.split('\n', 1)[0] ?? '';
    // user nice system idle iowait irq softirq steal; guest time is already folded into user/nice.
    const values = line.trim().split(/\s+/).slice(1, 9).map((value) => Number.parseInt(value, 10));
    return values.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
  } catch {
    return 0;
  }
}

function processDisplayName(comm: string, commandLine: string): string {
  const args = commandLine.split(/\s+/).filter(Boolean);
  // The first non-flag argument after argv[0] disambiguates e.g. many `node` processes.
  const script = args.slice(1).find((arg) => !arg.startsWith('-'));
  const base = script?.split('/').pop()?.replace(/[^\w.@+-]/g, '_') ?? '';
  const name = base === '' || base === comm ? comm : `${comm}:${base}`;
  return name.length > PROCESS_NAME_MAX ? `${name.slice(0, PROCESS_NAME_MAX - 1)}…` : name;
}

async function readProcessStat(pid: number, pidText: string): Promise<ProcessStatSample | null> {
  try {
    const stat = await readFile(`/proc/${pidText}/stat`, 'utf8');
    const open = stat.indexOf('(');
    // `comm` may contain spaces and parentheses, so anchor on the final closing paren.
    const close = stat.lastIndexOf(')');
    if (open < 0 || close <= open) return null;
    const comm = stat.slice(open + 1, close);
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    // fields[0] is field 3 (state); utime/stime/starttime are fields 14/15/22 -> indexes 11/12/19.
    const utime = Number.parseInt(fields[11] ?? '', 10);
    const stime = Number.parseInt(fields[12] ?? '', 10);
    const startTime = Number.parseInt(fields[19] ?? '', 10);
    if (!Number.isFinite(utime) || !Number.isFinite(stime) || !Number.isFinite(startTime)) return null;
    const [statm, cmdline] = await Promise.all([
      readFile(`/proc/${pidText}/statm`, 'utf8').catch(() => ''),
      readFile(`/proc/${pidText}/cmdline`, 'utf8').catch(() => ''),
    ]);
    const commandLine = cmdline.replace(/\0/g, ' ').trim();
    // Kernel threads expose an empty cmdline and are not useful on a dashboard.
    if (commandLine === '') return null;
    const rssPages = Number.parseInt(statm.trim().split(/\s+/)[1] ?? '', 10);
    return {
      pid,
      name: processDisplayName(comm, commandLine),
      jiffies: utime + stime,
      startTime,
      memoryBytes: Number.isFinite(rssPages) && rssPages > 0 ? rssPages * PAGE_SIZE_BYTES : 0,
    };
  } catch {
    // The process exited between readdir and read; skip it.
    return null;
  }
}

async function readProcessSamples(): Promise<{ readonly total: number; readonly samples: readonly RawProcessSample[] }> {
  let entries: string[];
  try {
    entries = await readdir('/proc');
  } catch {
    return { total: 0, samples: [] };
  }
  const pids = entries.filter((name) => /^[0-9]+$/.test(name));
  const totalJiffies = await readTotalCpuJiffies();
  const cores = os.cpus().length || 1;
  const uptimeSeconds = os.uptime();
  const previous = previousProcessSampling;
  const totalDelta = previous === null ? 0 : totalJiffies - previous.totalJiffies;
  const samples: RawProcessSample[] = [];
  const nextState = new Map<number, number>();

  for (let offset = 0; offset < pids.length; offset += PROCESS_READ_BATCH) {
    const batch = pids.slice(offset, offset + PROCESS_READ_BATCH);
    const parsed = await Promise.all(batch.map((pidText) => readProcessStat(Number.parseInt(pidText, 10), pidText)));
    for (const sample of parsed) {
      if (sample === null) continue;
      const before = previous?.processes.get(sample.pid);
      let cpuPercent: number;
      if (totalDelta > 0 && before !== undefined && sample.jiffies >= before) {
        cpuPercent = ((sample.jiffies - before) / totalDelta) * cores * 100;
      } else {
        // First snapshot after boot/restart: fall back to the process lifetime average, like `ps`.
        const ageSeconds = Math.max(1, uptimeSeconds - sample.startTime / CLOCK_TICKS_PER_SECOND);
        cpuPercent = (sample.jiffies / CLOCK_TICKS_PER_SECOND / ageSeconds) * 100;
      }
      samples.push({
        pid: sample.pid,
        name: sample.name,
        cpuPercent: Math.round(Math.min(cores * 100, Math.max(0, cpuPercent)) * 10) / 10,
        memoryBytes: sample.memoryBytes,
      });
      nextState.set(sample.pid, sample.jiffies);
    }
  }

  previousProcessSampling = { totalJiffies, processes: nextState };
  return { total: pids.length, samples };
}

function summarizeProcesses(samples: readonly RawProcessSample[], totalMemoryBytes: number): HostProcessMetrics {
  const enrich = (sample: RawProcessSample): HostProcessEntry => ({
    ...sample,
    memoryPercent: totalMemoryBytes > 0 ? Math.round((sample.memoryBytes / totalMemoryBytes) * 1000) / 10 : 0,
  });
  const active = samples.filter((sample) => sample.cpuPercent > 0.05 || sample.memoryBytes > 0);
  return {
    total: samples.length,
    topCpu: [...active].sort((left, right) => right.cpuPercent - left.cpuPercent).slice(0, TOP_PROCESS_LIMIT).map(enrich),
    topMemory: [...active].sort((left, right) => right.memoryBytes - left.memoryBytes).slice(0, TOP_PROCESS_LIMIT).map(enrich),
  };
}

function formatProcessSummary(entries: readonly HostProcessEntry[], format: (entry: HostProcessEntry) => string): string {
  if (entries.length === 0) return 'n/a';
  return entries.map((entry) => `${entry.name} ${format(entry)}`).join(' · ');
}

export async function readHostMetrics(): Promise<HostMetricsSnapshot> {
  const [memInfo, swapDevices, zramDevices, disk, mountedDisks, processSamples] = await Promise.all([
    readMemInfo(),
    readSwapDevices(),
    readZramDevices(),
    statfs('/'),
    readMountedDisks(),
    readProcessSamples(),
  ]);
  const memory = memInfo;
  const processes = summarizeProcesses(processSamples.samples, memory.total);
  const diskTotal = disk.blocks * disk.bsize;
  const diskAvailable = disk.bavail * disk.bsize;
  const diskUsed = diskTotal - disk.bfree * disk.bsize;
  const loaded = os.loadavg();
  const cpus = os.cpus();
  const uptimeSeconds = Math.round(os.uptime());
  const usagePercent = cpuUsagePercent();
  const cpuTempC = await readCpuTemp();
  const memoryUsedBytes = Math.max(0, memory.total - memory.available);
  const swapTotalBytes = swapDevices.reduce((sum, device) => sum + device.sizeBytes, 0);
  const swapUsedBytes = swapDevices.reduce((sum, device) => sum + device.usedBytes, 0);
  const zramSummary = zramDevices.length === 0
    ? 'off'
    : zramDevices
      .map((device) => `${device.name} ${device.algorithm} ${formatBytes(device.diskSizeBytes)}/${formatPercent(device.memoryUsedBytes, device.diskSizeBytes)}`)
      .join(', ');
  return {
    hostname: os.hostname(),
    platform: `${os.platform()} ${os.arch()}`,
    release: os.release(),
    uptimeSeconds,
    collectedAt: new Date().toISOString(),
    cpu: {
      cores: cpus.length,
      model: cpus[0]?.model.trim() ?? 'unknown',
      load1: loaded[0] ?? 0,
      load5: loaded[1] ?? 0,
      load15: loaded[2] ?? 0,
      usagePercent,
    },
    memory: {
      totalBytes: memory.total,
      usedBytes: memoryUsedBytes,
      availableBytes: memory.available,
    },
    swap: {
      totalBytes: swapTotalBytes,
      usedBytes: swapUsedBytes,
      devices: swapDevices,
    },
    zram: {
      enabled: zramDevices.length > 0,
      devices: zramDevices,
    },
    disk: {
      mount: '/',
      totalBytes: diskTotal,
      usedBytes: diskUsed,
      availableBytes: diskAvailable,
      usedPercent: diskTotal > 0 ? Math.round((diskUsed / diskTotal) * 1000) / 10 : 0,
    },
    disks: mountedDisks,
    processes,
    display: {
      ...Object.fromEntries(mountedDisks.map((entry) => [`disk_${entry.key}`, entry.display])),
      cpu: `${usagePercent === null ? 'n/a' : `${usagePercent}%`} · load ${(loaded[0] ?? 0).toFixed(2)}`,
      cpu_load: (loaded[0] ?? 0).toFixed(2),
      cpu_temp: cpuTempC === null ? 'n/a' : `${cpuTempC.toFixed(1)}°C`,
      top_cpu: formatProcessSummary(processes.topCpu, (entry) => `${entry.cpuPercent}%`),
      top_ram: formatProcessSummary(processes.topMemory, (entry) => formatBytes(entry.memoryBytes)),
      memory: `${formatBytes(memoryUsedBytes)} / ${formatBytes(memory.total)} (${formatPercent(memoryUsedBytes, memory.total)})`,
      swap: `${formatBytes(swapUsedBytes)} / ${formatBytes(swapTotalBytes)} (${formatPercent(swapUsedBytes, swapTotalBytes)})`,
      disk: `${formatPercent(diskUsed, diskTotal)} of ${formatBytes(diskTotal)}`,
      zram: zramSummary,
      uptime: formatUptime(uptimeSeconds),
    },
  };
}
