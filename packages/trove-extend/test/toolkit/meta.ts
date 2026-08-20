import type { ToolkitConfig } from '../../src/toolkit/types.js';

/**
 * The manifest half of a toolkit, for tests that are about behaviour.
 *
 * `defineToolkit` requires a toolkit to say what it is, because the manifest is
 * generated from that declaration rather than hand-written alongside it. A test
 * exercising dispatch or auth still has to supply it; spreading one fixture
 * keeps that requirement from drowning the thing each test is actually about.
 */
export const TOOLKIT_META: Omit<ToolkitConfig, 'tools'> = {
  id: 'example-toolkit',
  name: 'Example Toolkit',
  description: 'A toolkit used by the test suite.',
  icon: '🧪',
  version: '1.0.0',
};
