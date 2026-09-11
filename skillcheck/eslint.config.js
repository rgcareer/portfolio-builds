import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Determinism guardrails (see plan §"Determinism"): anything that can silently
// break bit-for-bit reproducibility is banned in source. `core/prng.ts` is the one
// place a controlled PRNG lives; nothing here needs Math.random, but the override
// documents the boundary.
const determinismBans = {
  'no-restricted-properties': [
    'error',
    { object: 'Math', property: 'random', message: 'Non-deterministic. Use core/prng (mulberry32).' },
  ],
  'no-restricted-syntax': [
    'error',
    {
      selector: "MemberExpression[property.name='localeCompare']",
      message: 'Locale-dependent ordering breaks reproducibility. Use bytewise comparison.',
    },
    {
      selector: "MemberExpression[property.name=/^toLocale/]",
      message: 'Locale-dependent formatting breaks reproducibility. Use locale-independent formatting.',
    },
  ],
};

export default tseslint.config(
  { ignores: ['**/dist/**', 'node_modules/**', 'site/**', 'data/**', '**/fixtures/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['packages/**/*.ts'],
    rules: {
      ...determinismBans,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // The PRNG module is the sanctioned home for controlled pseudo-randomness.
    files: ['packages/core/src/prng.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
  {
    // Tests may assert on non-deterministic APIs and use loose typing.
    files: ['packages/**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-restricted-syntax': 'off',
    },
  },
);
