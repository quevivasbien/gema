import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
    globalIgnores([
        "node_modules/",
        "**/dist/**/*", // Ignores contents of dist/
        "**/build/**/*", // Ignores contents of build/
    ]),
    {
        files: ["**/*.{js,mjs,cjs,ts,mts,cts}"],
        ...js.configs.recommended,
        languageOptions: { globals: globals.node },
    },
    tseslint.configs.recommended,
    {
        rules: {
            "@typescript-eslint/no-unused-vars": [
                "error",
                { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
            ],
            "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
        },
    },
]);
