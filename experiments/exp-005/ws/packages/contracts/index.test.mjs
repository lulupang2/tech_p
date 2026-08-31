import {test} from "node:test"; import assert from "node:assert"; import {SOURCE_KEYS} from "./index.mjs"; test("keys", () => assert.equal(SOURCE_KEYS.length, 3));
