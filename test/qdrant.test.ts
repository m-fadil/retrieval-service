import test from "node:test";
import assert from "node:assert/strict";
import { pointId } from "../src/services/qdrant.js";

test("pointId creates deterministic qdrant-compatible uuid", () => {
  const id = pointId("smoke-doc");
  assert.match(
    id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  assert.equal(pointId("smoke-doc"), id);
});
