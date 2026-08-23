// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/cdk.out/**",
      "**/*.d.ts",
      "**/coverage/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // CLAUDE.md: avoid `any` unless unavoidable and justified.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",

      // A dropped promise in a worker silently loses business work.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/require-await": "error",
      "@typescript-eslint/return-await": ["error", "always"],

      // Observability is structured; console.log is not an accepted log sink.
      "no-console": "error",

      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true },
      ],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-restricted-globals": [
        "error",
        {
          name: "setTimeout",
          message:
            "Import a Clock/sleep abstraction so waits stay deadline-aware and testable.",
        },
      ],
    },
  },
  {
    // The fake provider is a test double: it is allowed to be a plain process.
    files: ["apps/fake-provider/**/*.ts", "tests/**/*.ts", "packages/testing/**/*.ts"],
    rules: {
      "no-console": "off",
      "no-restricted-globals": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
