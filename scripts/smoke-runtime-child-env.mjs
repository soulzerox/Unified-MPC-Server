/* global process */
import path from 'node:path';

/**
 * Environment for the throwaway MCP HTTP runtime that the smoke boots.
 *
 * The runtime must look like a fresh machine, and pointing only
 * `UNIFIED_MPC_DATA_PATH` at the temporary root does not achieve that. Before
 * opening SQLite the runtime compares its canonical data root against the
 * home-derived historical roots (`$HOME/.local/share/unified-mpc` and
 * `$XDG_DATA_HOME/unified-mpc`) and refuses to start when a real installation
 * already lives there:
 *
 * ```text
 * STORAGE_IDENTITY_DRIFT: canonical storage has no persisted gateway settings
 * while historical database exists at <home>/.local/share/unified-mpc/unified-mpc.sqlite
 * ```
 *
 * That is correct for an operator — the guard exists so a fresh canonical
 * database never silently replaces persisted gateway settings — but it makes
 * the smoke fail on every machine that has run unified-mpc once, which is also
 * why `release:verify` could not pass locally. Redirecting `HOME` and the XDG
 * roots into the temporary root keeps the guard intact and gives it a clean
 * machine to inspect, instead of teaching the runtime to ignore the mismatch.
 */
export function createSmokeChildEnv({ temporaryRoot, baseEnv = process.env }) {
  const homeRoot = path.join(temporaryRoot, 'home');
  return {
    ...baseEnv,
    HOME: homeRoot,
    XDG_DATA_HOME: path.join(homeRoot, '.local', 'share'),
    XDG_STATE_HOME: path.join(homeRoot, '.local', 'state'),
    XDG_CONFIG_HOME: path.join(homeRoot, '.config'),
    UNIFIED_MPC_WORKSPACE: path.join(temporaryRoot, 'workspace'),
    UNIFIED_MPC_DATA_PATH: path.join(temporaryRoot, 'data'),
    // Port 0 keeps parallel smoke runs and a live desktop runtime apart.
    UNIFIED_MPC_PORT: '0',
  };
}
