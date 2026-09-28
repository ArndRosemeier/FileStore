import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { App } from '@/App';

/**
 * The smoke pin. It exists for two reasons and both are worth keeping:
 *
 *  1. THE HARNESS IS PROVEN END TO END. A green suite proves jsdom, the `@/`
 *     alias, the React plugin, `tests/setup.ts` and Testing Library all agree —
 *     which is the one thing that cannot be proven by reading config. A writer
 *     copies this file's shape rather than inventing a second fixture set.
 *  2. THE APP MOUNTS AND SAYS ITS NAME. The shell is the one component every
 *     other slice renders inside; if it throws, nothing else can be tested.
 *
 * It deliberately asserts only the app's name, so it survives the UI slice that
 * replaces the placeholder shell's body.
 */
describe('the app shell', () => {
  it('mounts and names the app', () => {
    render(<App />);

    expect(screen.getByRole('heading', { name: 'FileStore' })).toBeInTheDocument();
  });
});
