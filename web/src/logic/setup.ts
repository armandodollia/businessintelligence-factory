/**
 * The setup check and the data folder on the Settings page (design
 * 2026-11-16-desktop-app-and-feedback-bundle-design.md §4.2, §4.3): which agent CLIs are installed and
 * signed in, whether Chrome is there, where this computer keeps the data, and writing the
 * configuration that fits what was found.
 */
import { useCallback, useEffect, useState } from 'react';
import { setupApi } from './api.js';
import type { CliCheck, SetupInfo } from './types.js';

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The state of an agent CLI in two words. */
export function cliState(c: Pick<CliCheck, 'found' | 'runs' | 'signedIn'>): string {
  if (!c.found) return 'not found';
  if (!c.runs) return 'does not run';
  return c.signedIn === 'yes' ? 'signed in' : c.signedIn === 'no' ? 'not signed in' : 'sign-in not known';
}

/** What replacing an existing configuration does, said before it is done. */
export const REPLACE_WARNING =
  'This switches off the agent CLIs that were not found, moves their roles to the first one that was found, and adds the cost caps when you have none. Your other settings are kept.';

export type SetupBusy = 'check' | 'apply' | 'open' | null;

/** The server's answer, when it is the setup check (an older server answers something else). */
async function readSetup(refresh: boolean): Promise<SetupInfo> {
  const info = (await setupApi.get(refresh)) as SetupInfo | null;
  if (!info || typeof info !== 'object' || typeof info.folders?.open !== 'string') throw new Error('This server did not answer the setup check.');
  return info;
}

/**
 * The setup check of the server. `onApplied` runs after the configuration was written (the Settings
 * page reloads its editor).
 */
export function useSetup(onApplied?: () => void) {
  const [info, setInfo] = useState<SetupInfo | null>(null);
  const [busy, setBusy] = useState<SetupBusy>('check');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (refresh: boolean) => {
    setBusy('check');
    setError(null);
    try {
      setInfo(await readSetup(refresh));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const apply = useCallback(
    async (overwrite: boolean) => {
      setBusy('apply');
      setError(null);
      setNotice(null);
      try {
        await setupApi.apply(overwrite);
        setInfo(await readSetup(false));
        setNotice('The configuration was written for what was found on this computer. It is in use now.');
        onApplied?.();
      } catch (e) {
        setError(errMsg(e));
      } finally {
        setBusy(null);
      }
    },
    [onApplied],
  );

  const openFolder = useCallback(async () => {
    setBusy('open');
    setError(null);
    try {
      await setupApi.openFolder();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  }, []);

  return { info, busy, error, notice, checkAgain: () => load(true), apply, openFolder };
}
