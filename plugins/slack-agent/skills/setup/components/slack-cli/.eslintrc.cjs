module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    project: './tsconfig.json',
  },
  plugins: ['@typescript-eslint', 'import'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  settings: {
    'import/resolver': {
      typescript: {
        project: './tsconfig.json',
      },
      node: {
        extensions: ['.ts', '.js'],
      },
    },
  },
  rules: {
    'import/no-restricted-paths': ['error', {
      zones: [
        { target: './src/write', from: './src/read' },
        { target: './src/read', from: './src/write' },
        { target: './src/common', from: './src/write' },
        { target: './src/common', from: './src/read' },
      ],
    }],
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'off',
  },
  ignorePatterns: ['dist/', 'node_modules/', 'tests/'],
};
