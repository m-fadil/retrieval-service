import test from "node:test";
import assert from "node:assert/strict";
import { isMissingCollection, pointId } from "../src/services/qdrant.js";

test("pointId creates deterministic qdrant-compatible uuid", () => {
  const id = pointId("smoke-doc");
  assert.match(
    id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  assert.equal(pointId("smoke-doc"), id);
});

test("isMissingCollection recognises the qdrant 404 error shape", () => {
  // The shape @qdrant/js-client-rest throws for a nonexistent collection.
  assert.equal(
    isMissingCollection({
      message: "Not Found",
      status: 404,
      data: {
        status: {
          error: "Not found: Collection `knowledge_base` doesn't exist!",
        },
      },
    }),
    true,
  );
  assert.equal(isMissingCollection({ status: 500 }), false);
  assert.equal(isMissingCollection(new Error("Not Found")), false);
  assert.equal(isMissingCollection(null), false);
  // A bare 404 without Qdrant's error body (misconfigured URL, proxy) must
  // fail loudly instead of masquerading as an empty collection.
  assert.equal(isMissingCollection({ status: 404 }), false);
  assert.equal(
    isMissingCollection({ status: 404, data: { status: { error: 404 } } }),
    false,
  );
});
