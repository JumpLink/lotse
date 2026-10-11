/** `@lotse/widget`'s `tool-line.ts` — a recorded tool line read back into a title, a status and an icon. */
import { describe, expect, it } from '@gjsify/unit';

// Past the barrel, which exports the widget and therefore imports `Adw` — this module imports
// nothing at all, which is what keeps these assertions running on Node as well as on GJS.
import type { ToolCallView } from '@lotse/core';
import {
  parseToolLine,
  toolIcon,
  toolRow,
  TOOL_FALLBACK_ICON,
  type ToolPresentation,
} from '@lotse/widget/tool-line';

export default async () => {
  await describe('parseToolLine', async () => {
    await it('splits the title from a known status', async () => {
      const line = parseToolLine('Read config.json — completed');
      expect(line.title).toBe('Read config.json');
      expect(line.status?.label).toBe('Done');
      expect(line.status?.tone).toBe('done');
    });
    await it('leaves a status-only line untitled', async () => {
      // No title rather than an invented one: the caller draws a status caption instead of a card.
      expect(parseToolLine('— failed').title).toBe('');
      expect(parseToolLine('— failed').status?.tone).toBe('failed');
    });
    await it('leaves a line without a known status whole', async () => {
      const line = parseToolLine('Run build — weird');
      expect(line.title).toBe('Run build — weird');
      expect(line.status).toBe(null);
    });
    await it('maps every known status to a label and a tone', async () => {
      const read = (status: string) => parseToolLine(`Run build — ${status}`).status;
      expect(read('pending')?.tone).toBe('running');
      expect(read('in_progress')?.label).toBe('Running');
      expect(read('completed')?.tone).toBe('done');
      expect(read('failed')?.label).toBe('Failed');
    });
    await it('keeps a dash inside the title and splits at the last one', async () => {
      const line = parseToolLine('Read a — b.txt — completed');
      expect(line.title).toBe('Read a — b.txt');
      expect(line.status?.tone).toBe('done');
    });
    await it('copes with an empty line', async () => {
      const line = parseToolLine('');
      expect(line.title).toBe('');
      expect(line.status).toBe(null);
    });
  });
  await describe('toolIcon', async () => {
    await it('reads the first word, with a fallback', async () => {
      expect(toolIcon('Search src')).toBe('edit-find-symbolic');
      expect(toolIcon('edit')).toBe('document-edit-symbolic');
      expect(toolIcon('Frobnicate')).toBe(TOOL_FALLBACK_ICON);
    });
    await it('knows the ACP kind words the permission dialog passes', async () => {
      expect(toolIcon('read')).toBe('document-open-symbolic');
      expect(toolIcon('delete')).toBe('edit-delete-symbolic');
      expect(toolIcon('move')).toBe('folder-symbolic');
      expect(toolIcon('search')).toBe('edit-find-symbolic');
      expect(toolIcon('fetch')).toBe('network-workgroup-symbolic');
      expect(toolIcon('execute')).toBe('system-run-symbolic');
      expect(toolIcon('other')).toBe(TOOL_FALLBACK_ICON);
    });
    await it('matches a word, not a prefix of one', async () => {
      expect(toolIcon('Reading list')).toBe(TOOL_FALLBACK_ICON);
    });
  });
  await describe('toolRow', async () => {
    const call: ToolCallView = {
      toolCallId: 'call_1',
      kind: 'other',
      title: 'execute',
      status: 'completed',
      mcp: [{ server: 'shop', tool: 'place_order', source: 'reported', input: { sku: 'A1' } }],
    };
    const warnings: string[] = [];
    const warn = (message: string) => warnings.push(message);

    await it('reads title, status and icon from the folded call, not the text', async () => {
      const row = toolRow('— completed', { ...call, kind: 'read', title: 'config.json' });
      expect(row.title).toBe('config.json');
      expect(row.status?.tone).toBe('done');
      expect(row.icon).toBe('document-open-symbolic');
      expect(row.subtitle).toBe(null);
    });

    await it('reads a legacy line from its text and never asks the presenter', async () => {
      let asked = false;
      const row = toolRow('Read a.ts — failed', null, () => {
        asked = true;
        return { title: 'mine' };
      });
      expect(asked).toBe(false);
      expect(row.title).toBe('Read a.ts');
      expect(row.status?.tone).toBe('failed');
    });

    await it("draws the host's presentation, with the agent's status", async () => {
      const row = toolRow('execute — completed', call, (view) =>
        view.mcp[0]?.tool === 'place_order'
          ? { title: 'Order placed', subtitle: 'A1', icon: 'cart-symbolic' }
          : null,
      );
      expect(row).toStrictEqual({
        title: 'Order placed',
        status: { label: 'Done', tone: 'done' },
        subtitle: 'A1',
        icon: 'cart-symbolic',
      });
    });

    await it('falls back silently on null', async () => {
      warnings.length = 0;
      const row = toolRow('execute — completed', call, () => null, warn);
      expect(row.title).toBe('execute');
      expect(warnings).toStrictEqual([]);
    });

    await it('falls back to the standard row, with one warning, when the presenter throws', async () => {
      warnings.length = 0;
      const row = toolRow(
        'execute — completed',
        call,
        () => {
          throw new Error('boom');
        },
        warn,
      );
      expect(row).toStrictEqual(toolRow('execute — completed', call));
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain('boom');
    });

    await it('falls back, with one warning, on a presentation it cannot draw', async () => {
      const bad = [
        {},
        { title: '' },
        { title: '  ' },
        { title: 'x', icon: 3 },
        { title: 'x', subtitle: {} },
        'x',
      ];
      for (const answer of bad) {
        warnings.length = 0;
        const row = toolRow('execute — completed', call, () => answer as unknown as ToolPresentation, warn);
        expect(row.title).toBe('execute');
        expect(warnings.length).toBe(1);
      }
    });
  });
};
