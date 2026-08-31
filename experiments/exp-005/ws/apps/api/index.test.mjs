import {test} from "node:test"; import assert from "node:assert"; import {isKnownSource} from "@exp/domain"; test("api uses domain", () => assert.ok(isKnownSource("github_releases")));
