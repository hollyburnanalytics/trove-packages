/**
 * The contract loader, tested where it lives.
 *
 * The fixture itself is executed by the three implementations that must obey it
 * — Trove's shim, the CLI's worker, the Mac runner — and none of them is this
 * package. So when the file moved here it arrived with no tests at all, and the
 * coverage gate would have said so on the first CI run had CI not been dying
 * seconds earlier on a stale lockfile.
 *
 * What is worth testing here is not the contract (that is the consumers' job)
 * but the LOADER: the `$repeat` expansion every implementation depends on, and
 * the section lists they use to prove they left nothing unexecuted. A silently
 * broken expander would hand all three sides a 12-character string where a 64 KB
 * one was meant, and every one of them would agree, and all of them would be
 * wrong together.
 *
 * @module
 */

import { describe, expect, it } from 'vitest';
import {
  CASE_SECTIONS,
  type ContractFixtures,
  contract,
  PRODUCER_SECTIONS,
  READER_SECTIONS,
} from '../../src/contract/index.js';

describe('the loaded contract', () => {
  it('is the versioned artefact all three implementations pin', () => {
    expect(contract.contract).toBe('source-invoke');
    expect(contract.version).toBe(1);
  });

  it('carries the limits the wire is actually held to', () => {
    expect(contract.constants.invokeUrl).toBe('https://invoke/sync');
    expect(contract.constants.maxCursorBytes).toBe(64 * 1024);
    expect(contract.constants.maxResponseBytes).toBe(4 * 1024 * 1024);
    expect(contract.constants.defaultDeadlineMs).toBeGreaterThan(0);
  });

  it('has every case-bearing section populated', () => {
    for (const section of CASE_SECTIONS) {
      expect(contract[section] as unknown[], `${section} is empty`).not.toHaveLength(0);
    }
  });

  it('classifies every section as producer or reader, with none left over', () => {
    // A section nobody classified is a section nobody runs — the failure this
    // whole arrangement exists to prevent, one level up.
    expect([...PRODUCER_SECTIONS, ...READER_SECTIONS].sort()).toEqual([...CASE_SECTIONS].sort());
  });

  it('states why every case exists', () => {
    // These are read by people in other repositories who cannot ask what a line
    // was for. A case with no stated failure is one nobody can safely delete —
    // or safely keep.
    for (const section of CASE_SECTIONS) {
      for (const testCase of contract[section] as { name: string; why: string }[]) {
        expect(testCase.why, `${section}: ${testCase.name}`).toBeTruthy();
      }
    }
  });

  it('declares no section the type does not know about', () => {
    const declared = (Object.keys(contract) as (keyof ContractFixtures)[]).filter(
      // `$`-prefixed keys are the file's prose for its human readers, not cases.
      (key) => !String(key).startsWith('$') && Array.isArray(contract[key]),
    );
    expect(declared.sort()).toEqual([...CASE_SECTIONS].sort());
  });
});

describe('the `$repeat` expansion', () => {
  it('produces the oversized values the size limits are tested with', () => {
    // The whole point of the placeholder: a 64 KB cursor and a 4 MiB body have
    // to exist as real strings, and cannot be written out in a file a human
    // reads. If this silently produced something short, every implementation
    // would agree the oversize cases pass, and all of them would be wrong.
    const oversized = contract.http.filter((c) => /too large|oversiz/i.test(c.name));
    expect(oversized.length).toBeGreaterThan(0);

    const longest = JSON.stringify(contract.http).length;
    expect(longest).toBeGreaterThan(contract.constants.maxResponseBytes);
  });

  it('leaves no unexpanded placeholder anywhere in the fixture', () => {
    // One missed node is one case asserting against the literal object
    // `{"$repeat":{…}}` instead of the string it stands for.
    //
    // Checked STRUCTURALLY rather than by searching the serialized text: the
    // fixture's own `$comment` explains the `$repeat` syntax in prose, so a
    // substring match finds the documentation and fails on a file that is
    // perfectly correct. (It did.)
    const unexpanded = (node: unknown): boolean => {
      if (Array.isArray(node)) return node.some(unexpanded);
      if (typeof node !== 'object' || node === null) return false;
      if ('$repeat' in node) return true;
      return Object.values(node).some(unexpanded);
    };
    expect(unexpanded(contract)).toBe(false);
  });
});
