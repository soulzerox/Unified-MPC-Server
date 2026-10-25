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

export async function readHostMetrics(): Promise<HostMetricsSnapshot> {
  const [memInfo, swapDevices, zramDevices, disk, mountedDisks] = await Promise.all([
    readMemInfo(),
    readSwapDevices(),
    readZramDevices(),
    statfs('/'),
    readMountedDisks(),
  ]);
  const memory = memInfo;
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
    display: {
      ...Object.fromEntries(mountedDisks.map((entry) => [`disk_${entry.key}`, entry.display])),
      cpu: `${usagePercent === null ? 'n/a' : `${usagePercent}%`} · load ${(loaded[0] ?? 0).toFixed(2)}`,
      cpu_load: (loaded[0] ?? 0).toFixed(2),
      cpu_temp: cpuTempC === null ? 'n/a' : `${cpuTempC.toFixed(1)}°C`,
      memory: `${formatBytes(memoryUsedBytes)} / ${formatBytes(memory.total)} (${formatPercent(memoryUsedBytes, memory.total)})`,
      swap: `${formatBytes(swapUsedBytes)} / ${formatBytes(swapTotalBytes)} (${formatPercent(swapUsedBytes, swapTotalBytes)})`,
      disk: `${formatPercent(diskUsed, diskTotal)} of ${formatBytes(diskTotal)}`,
      zram: zramSummary,
      uptime: formatUptime(uptimeSeconds),
    },
  };
}
