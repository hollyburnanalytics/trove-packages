import type { ToolkitConfig } from '@ontrove/extend/toolkit';

/**
 * The manifest half of a toolkit, for CLI tests that are about the toolchain.
 *
 * `defineToolkit` requires a toolkit to declare itself, because its manifest is
 * generated from that declaration. A test about bundling or serving still has
 * to supply it; one fixture keeps that from crowding out the subject.
 */
export const TOOLKIT_META: Omit<ToolkitConfig, 'tools'> = {
  id: 'example-toolkit',
  name: 'Example Toolkit',
  description: 'A toolkit used by the CLI test suite.',
  icon: '🧪',
  version: '1.0.0',
};
