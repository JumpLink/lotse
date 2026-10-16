/**
 * The two host rules about a tool call, tested without a window — `host-tools.ts`.
 *
 * **The negative guarantee is what these cases are for.** "lotse never approves a host-confirmed tool
 * through `session/request_permission`" and "an always-allow under a session scope is never handed to
 * the agent and never written down" are both sentences about something that must *not* happen, and
 * neither is visible in a screenshot: a dialog that was not shown looks like a dialog nobody opened,
 * and a grant that was not persisted looks like a grant nobody gave. So the order inside `toolGate`,
 * the id `hostConfirmDecision` picks, and the swap `sessionAnswer` makes are each asserted directly,
 * on GJS and on Node, with no display anywhere.
 */
import { describe, expect, it } from '@gjsify/unit';

import {
  HOST_CONFIRM_NO_ONCE_NOTE,
  SessionGrants,
  hostConfirmDecision,
  hostConfirmed,
  hostToolProblems,
  matchesTool,
  narrowestAllow,
  narrowestReject,
  permissionView,
  scopedOptions,
  sessionAnswer,
  toolGate,
  toolRefOf,
  type HostToolPolicy,
  type PermissionView,
} from '@lotse/core';

import type { PermissionOption, RequestPermissionRequest } from '@lotse/acp/types';

const ALL_FOUR: PermissionOption[] = [
  { optionId: 'ao', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'aa', name: 'Always allow in this session', kind: 'allow_always' },
  { optionId: 'ro', name: 'Decline', kind: 'reject_once' },
  { optionId: 'ra', name: 'Always decline', kind: 'reject_always' },
];

function request(
  overrides: Partial<NonNullable<RequestPermissionRequest['toolCall']>> = {},
  options: PermissionOption[] = ALL_FOUR,
): RequestPermissionRequest {
  return {
    sessionId: 's1',
    toolCall: {
      toolCallId: 't1',
      status: 'pending',
      title: 'Write src/hello.ts',
      kind: 'edit',
      rawInput: { path: 'src/hello.ts' },
      ...overrides,
    },
    options,
  } as RequestPermissionRequest;
}

/** The MCP shape a host recognises its own tool by: the server's reported call. */
function mcpRequest(tool: string, options: PermissionOption[] = ALL_FOUR): RequestPermissionRequest {
  return request(
    {
      title: 'Submit the return',
      kind: 'other',
      rawOutput: { metadata: { toolCalls: [{ tool, status: 'pending' }] } },
    },
    options,
  );
}

function view(options: PermissionOption[]): PermissionView {
  return permissionView(request({}, options));
}

export default async () => {
  describe('host-tools: the call a rule is matched against', () => {
    it('carries the title, the kind and every MCP name', () => {
      const ref = toolRefOf(mcpRequest('steuererklaerung.elster_submit'));
      expect(ref.title).toBe('Submit the return');
      expect(ref.kind).toBe('other');
      expect(ref.names).toContain('steuererklaerung.elster_submit');
      // The bare tool name too, so a host may name it without knowing which server it arrived on.
      expect(ref.names).toContain('elster_submit');
      expect(ref.names).toContain('Submit the return');
    });

    it('falls back the way the projection does on a malformed message', () => {
      const ref = toolRefOf({ sessionId: 's1', options: [] } as unknown as RequestPermissionRequest);
      expect(ref.title).toBe('unnamed tool');
      expect(ref.kind).toBe('unknown');
      expect(ref.names).toStrictEqual(['unnamed tool']);
    });

    it('matches a name exactly, never as a fragment', () => {
      const ref = toolRefOf(mcpRequest('steuererklaerung.elster_submit'));
      expect(matchesTool({ name: 'elster_submit' }, ref)).toBe(true);
      // Case and padding are not a different tool; a fragment is.
      expect(matchesTool({ name: '  ELSTER_SUBMIT ' }, ref)).toBe(true);
      expect(matchesTool({ name: 'elster' }, ref)).toBe(false);
      expect(matchesTool({ name: 'elster_submit_draft' }, ref)).toBe(false);
    });

    it('ANDs a name with a kind, and matches nothing when given neither', () => {
      const ref = toolRefOf(request());
      expect(matchesTool({ kind: 'edit' }, ref)).toBe(true);
      expect(matchesTool({ kind: 'execute' }, ref)).toBe(false);
      expect(matchesTool({ name: 'Write src/hello.ts', kind: 'edit' }, ref)).toBe(true);
      expect(matchesTool({ name: 'Write src/hello.ts', kind: 'execute' }, ref)).toBe(false);
      // The empty rule is the dangerous one: it must cover nothing rather than everything.
      expect(matchesTool({}, ref)).toBe(false);
      expect(matchesTool({ name: '   ' }, ref)).toBe(false);
    });

    it('reports a rule that names neither, so a host hears about it', () => {
      const policy: HostToolPolicy = {
        hostConfirmed: [{ name: 'elster_submit' }, {}, { kind: '  ' }],
      };
      const problems = hostToolProblems(policy);
      expect(problems.length).toBe(2);
      // Numbered from one and in the host's own order, so the sentence points at a rule.
      expect(problems[0]?.includes('2')).toBe(true);
      expect(problems[1]?.includes('3')).toBe(true);
      expect(hostToolProblems(undefined)).toStrictEqual([]);
      expect(hostToolProblems({})).toStrictEqual([]);
    });

    it('survives a host that passed something that is not a rule', () => {
      const policy = { hostConfirmed: [null, 'edit', 7] } as unknown as HostToolPolicy;
      expect(hostConfirmed(policy, toolRefOf(request()))).toBe(false);
      expect(hostToolProblems(policy).length).toBe(3);
      expect(
        hostConfirmed({ hostConfirmed: 'edit' } as unknown as HostToolPolicy, toolRefOf(request())),
      ).toBe(false);
    });
  });

  describe('host-tools: the tool the host confirms itself', () => {
    const policy: HostToolPolicy = { hostConfirmed: [{ name: 'elster_submit' }] };

    it('goes to the host and never to lotse’s dialog', () => {
      const gate = toolGate({
        view: permissionView(mcpRequest('steuererklaerung.elster_submit')),
        ref: toolRefOf(mcpRequest('steuererklaerung.elster_submit')),
        sessionId: 's1',
        policy,
      });
      expect(gate.type).toBe('host-confirm');
    });

    it('is not covered by an always-allow given earlier in the session', () => {
      const grants = new SessionGrants();
      // An "always allow" for the same kind, given before the host's rule was ever exercised.
      const earlier = mcpRequest('steuererklaerung.elster_submit');
      grants.allow('s1', toolRefOf(earlier));
      expect(grants.allows('s1', toolRefOf(earlier))).toBe(true);
      // The grant exists and is still not the answer: the host is asked first, which is the rule.
      const gate = toolGate({
        view: permissionView(earlier),
        ref: toolRefOf(earlier),
        sessionId: 's1',
        policy,
        grants,
      });
      expect(gate.type).toBe('host-confirm');
    });

    it('answers a host’s yes with the agent’s own one-time option', () => {
      const decision = hostConfirmDecision(view(ALL_FOUR), true);
      expect(decision).toStrictEqual({ type: 'allowed', optionId: 'ao' });
    });

    it('approves nothing when the agent offered no one-time option', () => {
      const onlyAlways: PermissionOption[] = [
        { optionId: 'aa', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'ro', name: 'Decline', kind: 'reject_once' },
      ];
      // A yes that could only be answered `allow_always` is not answered at all: a PIN asked once a
      // session is not a PIN.
      expect(hostConfirmDecision(view(onlyAlways), true)).toStrictEqual({
        type: 'not-answered',
        reason: 'dismissed',
      });
      expect(HOST_CONFIRM_NO_ONCE_NOTE().length > 0).toBe(true);
    });

    it('declines with the narrowest rejecting option, and fails closed without one', () => {
      expect(hostConfirmDecision(view(ALL_FOUR), false)).toStrictEqual({ type: 'declined', optionId: 'ro' });
      const onlyAlwaysReject: PermissionOption[] = [
        { optionId: 'ao', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'ra', name: 'Always decline', kind: 'reject_always' },
      ];
      expect(hostConfirmDecision(view(onlyAlwaysReject), false)).toStrictEqual({
        type: 'declined',
        optionId: 'ra',
      });
      const nothingToReject: PermissionOption[] = [
        { optionId: 'ao', name: 'Allow once', kind: 'allow_once' },
      ];
      expect(hostConfirmDecision(view(nothingToReject), false)).toStrictEqual({
        type: 'not-answered',
        reason: 'dismissed',
      });
    });

    it('reads the narrowest option of each direction', () => {
      expect(narrowestAllow(ALL_FOUR)?.optionId).toBe('ao');
      expect(narrowestReject(ALL_FOUR)?.optionId).toBe('ro');
      expect(narrowestAllow([ALL_FOUR[1] as PermissionOption])?.optionId).toBe('aa');
      expect(narrowestAllow([ALL_FOUR[2] as PermissionOption])).toBe(null);
      expect(narrowestReject([ALL_FOUR[0] as PermissionOption])).toBe(null);
    });
  });

  describe('host-tools: an always-allow that lives one session', () => {
    const session: HostToolPolicy = { alwaysAllow: 'session' };

    it('leaves every option alone under the agent’s own scope', () => {
      expect(scopedOptions(ALL_FOUR, undefined).length).toBe(4);
      expect(scopedOptions(ALL_FOUR, 'agent').length).toBe(4);
    });

    it('keeps the always button only while there is a once to answer with', () => {
      expect(scopedOptions(ALL_FOUR, 'session').map((option) => option.optionId)).toStrictEqual([
        'ao',
        'aa',
        'ro',
        'ra',
      ]);
      const noOnce: PermissionOption[] = [
        { optionId: 'aa', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'ro', name: 'Decline', kind: 'reject_once' },
      ];
      // Withdrawn rather than shown as a promise lotse would have to hand to the agent to keep.
      expect(scopedOptions(noOnce, 'session').map((option) => option.optionId)).toStrictEqual(['ro']);
    });

    it('sends the once and remembers the always itself', () => {
      const answered = sessionAnswer(view(ALL_FOUR), 'aa', 'session');
      expect(answered).toStrictEqual({ optionId: 'ao', remember: true });
      // Anything that is not an always-allow is the identity, under either scope.
      expect(sessionAnswer(view(ALL_FOUR), 'ao', 'session')).toStrictEqual({
        optionId: 'ao',
        remember: false,
      });
      expect(sessionAnswer(view(ALL_FOUR), 'ro', 'session')).toStrictEqual({
        optionId: 'ro',
        remember: false,
      });
      expect(sessionAnswer(view(ALL_FOUR), 'aa', 'agent')).toStrictEqual({ optionId: 'aa', remember: false });
      expect(sessionAnswer(view(ALL_FOUR), 'aa', undefined)).toStrictEqual({
        optionId: 'aa',
        remember: false,
      });
    });

    it('passes no lasting id on when there is no once, and remembers nothing', () => {
      const noOnce: PermissionOption[] = [{ optionId: 'aa', name: 'Always allow', kind: 'allow_always' }];
      expect(sessionAnswer(view(noOnce), 'aa', 'session')).toStrictEqual({ optionId: 'aa', remember: false });
    });

    it('answers the next matching call in the same session and asks again in a new one', () => {
      const grants = new SessionGrants();
      const first = request({ title: 'Write src/hello.ts' });
      grants.allow('s1', toolRefOf(first));
      // Keyed by the tool, not by the arguments: the next file is the same answer.
      const second = request({ title: 'Write src/other.ts' });
      const granted = toolGate({
        view: permissionView(second),
        ref: toolRefOf(second),
        sessionId: 's1',
        policy: session,
        grants,
      });
      expect(granted).toStrictEqual({ type: 'granted', optionId: 'ao' });
      // A new conversation has a new id, and therefore an empty memory.
      expect(
        toolGate({
          view: permissionView(second),
          ref: toolRefOf(second),
          sessionId: 's2',
          policy: session,
          grants,
        }).type,
      ).toBe('ask');
      expect(grants.sessions).toBe(1);
    });

    it('does not let one kind or one server stand in for another', () => {
      const grants = new SessionGrants();
      grants.allow('s1', toolRefOf(request({ title: 'Write src/hello.ts', kind: 'edit' })));
      const command = request({ title: 'Run tests', kind: 'execute' });
      expect(grants.allows('s1', toolRefOf(command))).toBe(false);
      grants.allow('s1', toolRefOf(mcpRequest('steuererklaerung.elster_submit')));
      expect(grants.allows('s1', toolRefOf(mcpRequest('paperless.elster_submit')))).toBe(false);
      expect(grants.allows('s1', toolRefOf(mcpRequest('steuererklaerung.elster_submit')))).toBe(true);
    });

    it('asks the person when a grant exists and this request offers nothing allowing', () => {
      const grants = new SessionGrants();
      const nothingAllowing: PermissionOption[] = [{ optionId: 'ro', name: 'Decline', kind: 'reject_once' }];
      const call = request({}, nothingAllowing);
      grants.allow('s1', toolRefOf(call));
      // There is no id to send, and inventing one is the single thing a gate may never do.
      expect(
        toolGate({
          view: permissionView(call),
          ref: toolRefOf(call),
          sessionId: 's1',
          policy: session,
          grants,
        }).type,
      ).toBe('ask');
    });

    it('forgets on request, and keeps nothing a session id cannot reach', () => {
      const grants = new SessionGrants();
      const call = request();
      grants.allow('s1', toolRefOf(call));
      grants.allow('s2', toolRefOf(call));
      expect(grants.sessions).toBe(2);
      grants.forget('s1');
      expect(grants.allows('s1', toolRefOf(call))).toBe(false);
      expect(grants.allows('s2', toolRefOf(call))).toBe(true);
      grants.forget();
      expect(grants.sessions).toBe(0);
    });

    it('is lotse’s own behaviour with no policy at all', () => {
      const call = request();
      const gate = toolGate({ view: permissionView(call), ref: toolRefOf(call), sessionId: 's1' });
      expect(gate.type).toBe('ask');
      expect(gate.type === 'ask' ? gate.options.length : 0).toBe(4);
    });
  });
};
