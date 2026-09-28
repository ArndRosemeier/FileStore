/**
 * The app shell.
 *
 * DAY-1 PLACEHOLDER. The dispatcher put this here so the day-1 tree typechecks,
 * builds and publishes; it is deliberately honest about doing nothing rather
 * than pretending to be the feature. The real shell — the settings panel, the
 * file list, upload and save — is the UI slice (see docs/BOARD.md); the write
 * slice that replaces this file owns it.
 */
export function App(): React.JSX.Element {
  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-semibold">FileStore</h1>
      <p className="text-ink-muted mt-4">
        The seams are being built. This build has no store browser yet — see{' '}
        <code>docs/BOARD.md</code> for what is in flight.
      </p>
    </main>
  );
}
