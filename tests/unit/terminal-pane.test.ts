// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/vue';

const terminalWrites = vi.hoisted(() => vi.fn());
vi.mock('../../src/sidepanel/terminal-manager', () => ({
  TerminalManager: class {
    mount = vi.fn();
    write = terminalWrites;
    dispose = vi.fn();
  },
}));

import TerminalPane from '../../src/sidepanel/components/TerminalPane.vue';

afterEach(() => { cleanup(); terminalWrites.mockReset(); });

describe('TerminalPane', () => {
  it('writes only deltas that were appended since the previous prop update', async () => {
    // Break caught: each accumulated parent chunk list is replayed, duplicating terminal output.
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn() });
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Chrome' });
    const view = render(TerminalPane, { props: { chunks: [] } });
    await Promise.resolve(); await Promise.resolve();
    await view.rerender({ chunks: ['first'] });
    await view.rerender({ chunks: ['first', 'second'] });

    await vi.waitFor(() => expect(terminalWrites).toHaveBeenCalledTimes(2));
    expect(terminalWrites.mock.calls.map(([chunk]) => chunk)).toEqual(['first', 'second']);
  });
});
