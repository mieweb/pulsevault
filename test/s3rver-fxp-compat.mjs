// s3rver 3.7.1 is written against the fast-xml-parser v3 API (`parse`,
// `validate`, `j2xParser`, `getTraversalObj`), but that release line has open
// security advisories, so package.json overrides s3rver's copy to the
// maintained v5 — whose API is `XMLParser`/`XMLBuilder`/`XMLValidator`.
// s3rver is unmaintained/frozen and will never port itself, so this module
// grafts the v3 entry points s3rver calls onto the v5 module object before
// s3rver loads. Same test-only approach as `s3rver-listparts.mjs`.
//
// Import this BEFORE `s3rver` in any test file that uses it: it mutates the
// exact module instance s3rver will require (resolved from s3rver's own
// directory), and CJS caching makes the graft visible to it.
//
// v3 never processed XML entities itself — s3rver encodes/decodes via `he` in
// its own tagValueProcessors — so every parser/builder below sets
// `processEntities: false` to avoid double-encoding under v5's defaults.

import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const s3rverDir = path.dirname(require.resolve("s3rver/package.json"));
const fxp = createRequire(path.join(s3rverDir, "lib", "_resolve.js"))(
  "fast-xml-parser",
);
const { XMLParser, XMLBuilder, XMLValidator } = fxp;

// v3: parse(xmlData, options). Renames: parseNodeValue -> parseTagValue;
// tagValueProcessor swapped its argument order from (value, tagName) to
// (tagName, value).
fxp.parse = function parse(xmlData, options = {}) {
  const { tagValueProcessor, parseNodeValue, ...rest } = options;
  const parser = new XMLParser({
    ...rest,
    processEntities: false,
    parseTagValue: parseNodeValue === undefined ? true : parseNodeValue,
    ...(tagValueProcessor && {
      tagValueProcessor: (tagName, tagValue) =>
        tagValueProcessor(tagValue, tagName),
    }),
  });
  return parser.parse(xmlData);
};

// v3: validate(xmlData) -> true | { err }. Same contract on v5's XMLValidator.
fxp.validate = function validate(xmlData, options) {
  return XMLValidator.validate(xmlData, options);
};

// v3: new j2xParser(options).parse(jsObj) -> xml string. v5 renamed the class
// to XMLBuilder and the method to build(). Renames: attrNodeName ->
// attributesGroupName (keys inside the group are attribute names verbatim, so
// clear the '@_' prefix); the builder's tagValueProcessor gained a leading
// tagName argument.
fxp.j2xParser = class j2xParser {
  constructor(options = {}) {
    const { tagValueProcessor, attrNodeName, ...rest } = options;
    this.builder = new XMLBuilder({
      ...rest,
      processEntities: false,
      ...(attrNodeName && {
        attributesGroupName: attrNodeName,
        attributeNamePrefix: "",
      }),
      ...(tagValueProcessor && {
        tagValueProcessor: (tagName, tagValue) => tagValueProcessor(tagValue),
      }),
    });
  }

  parse(jsObj) {
    return this.builder.build(jsObj);
  }
};

// v3: getTraversalObj(xmlData) -> internal traversal tree. s3rver's only use
// is utils.getXmlRootTag, which reads
// `Object.values(traversal.child)[0][0].tagname`, so return just that shape.
// An empty document yields `child: {}`, which makes the caller throw on
// destructuring — the same failure mode as v3.
fxp.getTraversalObj = function getTraversalObj(xmlData) {
  const parsed = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    processEntities: false,
    ignoreDeclaration: true,
    ignorePiTags: true,
  }).parse(xmlData);
  const child = {};
  for (const tagname of Object.keys(parsed)) {
    child[tagname] = [{ tagname }];
  }
  return { child };
};
