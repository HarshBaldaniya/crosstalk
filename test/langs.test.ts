// Go, Rust, Java, C#, Ruby and PHP: declarations with real ranges, kinds, public or not, docs, the
// type a method belongs to, and who uses what across files.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CodeMap } from "../src/codemap/index";

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
beforeEach(() => {
  process.env.CROSSTALK_HOME = tmp("crosstalk-lang-home-");
});

async function mapOf(files: Record<string, string>): Promise<CodeMap> {
  const root = tmp("crosstalk-lang-repo-");
  for (const [p, t] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), t);
  }
  const map = new CodeMap(root);
  await map.refresh({ full: true });
  return map;
}

const decls = (map: CodeMap, file: string) => map.file(file)!.d.map((d) => `${d.p ? `${d.p}.` : ""}${d.n}:${d.k}:${d.s}-${d.e}${d.x ? ":pub" : ""}`);
const users = (map: CodeMap, file: string, name: string) => map.graph.usedBy(file, name).map((e) => `${e.from.name}@${e.from.file}${e.conf === "found" ? "" : `(${e.conf})`}`).sort();

test("Go: functions, methods on their type, structs, interfaces, constants; a package is its folder", async () => {
  const map = await mapOf({
    "go.mod": "module example.com/app\n\ngo 1.22\n",
    "internal/billing/charge.go": 'package billing\n\nimport (\n\t"fmt"\n\tdb "example.com/app/internal/store"\n)\n\n// Charge bills an invoice.\nfunc Charge(id string) error {\n\tdb.Save(id)\n\treturn fmt.Errorf("%s", helper())\n}\n\n// Invoice is one bill.\ntype Invoice struct{ Total int }\n\ntype Store interface{ Get() }\n\nfunc (i *Invoice) Pay() bool { return true }\n\nconst Rate = 18\nconst secret = 1\n',
    "internal/billing/help.go": "package billing\n\nfunc helper() string { return \"\" }\n",
    "internal/store/store.go": "package store\n\n// Save writes it.\nfunc Save(id string) {}\n",
  });
  assert.deepEqual(decls(map, "internal/billing/charge.go"), ["Charge:function:9-12:pub", "Invoice:class:15-15:pub", "Store:interface:17-17:pub", "Invoice.Pay:method:19-19:pub", "Rate:const:21-21:pub"]);
  assert.equal(map.file("internal/billing/charge.go")!.d[0].d, "Charge bills an invoice.");
  assert.equal(map.file("internal/billing/charge.go")!.d[1].d, "Invoice is one bill.");
  assert.deepEqual(users(map, "internal/store/store.go", "Save"), ["Charge@internal/billing/charge.go"], "through the module path in go.mod");
  assert.deepEqual(users(map, "internal/billing/help.go", "helper"), ["Charge@internal/billing/charge.go"], "same package, another file: no import needed");
  assert.match(map.find("Charge"), /^Charge {2}function {2}internal\/billing\/charge\.go:9-12/);
  const both = map.find("charge invoice").split("\n").slice(0, 2).join("\n");
  assert.match(both, /^Charge /m);
  assert.match(both, /^Invoice /m);
});

test("Rust: items, impl methods under their type, traits, public or not; crate:: and super:: paths", async () => {
  const map = await mapOf({
    "src/main.rs": "mod billing;\nmod db;\nfn main() { billing::charge(); }\n",
    "src/billing.rs": "use crate::db::save;\n\n/// Charge an invoice.\npub fn charge() -> u32 { save(); Invoice::new(); 1 }\n\npub struct Invoice { total: u32 }\n\nimpl Invoice {\n    pub fn new() -> Self { Invoice { total: 0 } }\n    fn private_helper(&self) {}\n}\n\npub trait Store { fn get(&self); }\n\npub enum Kind { A, B }\n",
    "src/db.rs": "/// Saves it.\npub fn save() {}\n",
  });
  assert.deepEqual(decls(map, "src/billing.rs"), ["charge:function:4-4:pub", "Invoice:class:6-6:pub", "Invoice.new:method:9-9:pub", "Invoice.private_helper:method:10-10", "Store:interface:13-13:pub", "Store.get:method:13-13", "Kind:enum:15-15:pub"]);
  assert.equal(map.file("src/billing.rs")!.d[0].d, "Charge an invoice.");
  assert.deepEqual(users(map, "src/db.rs", "save"), ["charge@src/billing.rs"]);
  assert.deepEqual(users(map, "src/billing.rs", "Invoice"), ["Invoice.new@src/billing.rs", "charge@src/billing.rs"]);
});

test("Java: classes, interfaces, enums, methods under their class, public or not; imports by package path", async () => {
  const map = await mapOf({
    "src/main/java/com/acme/billing/Billing.java": "package com.acme.billing;\n\nimport com.acme.db.Store;\n\n/** Charges invoices. */\npublic class Billing {\n  private final Store store = new Store();\n  public int charge(String id) { return Store.save(id); }\n  static void helper() {}\n}\n",
    "src/main/java/com/acme/db/Store.java": "package com.acme.db;\n\npublic class Store {\n  public static int save(String id) { return 1; }\n}\n",
    "src/main/java/com/acme/billing/Kind.java": "package com.acme.billing;\n\nenum Kind { A, B }\n\ninterface Api { void charge(); }\n",
  });
  assert.deepEqual(decls(map, "src/main/java/com/acme/billing/Billing.java"), ["Billing:class:6-10:pub", "Billing.charge:method:8-8:pub", "Billing.helper:method:9-9"]);
  assert.equal(map.file("src/main/java/com/acme/billing/Billing.java")!.d[0].d, "Charges invoices.");
  assert.deepEqual(decls(map, "src/main/java/com/acme/billing/Kind.java"), ["Kind:enum:3-3", "Api:interface:5-5", "Api.charge:method:5-5"]);
  assert.deepEqual(users(map, "src/main/java/com/acme/db/Store.java", "Store"), ["Billing.charge@src/main/java/com/acme/billing/Billing.java", "Billing@src/main/java/com/acme/billing/Billing.java"]);
});

test("C#: namespaces, classes, interfaces, records, methods; uses resolved by name, marked as less certain", async () => {
  const map = await mapOf({
    "Billing/Billing.cs": "using Acme.Db;\n\nnamespace Acme.Billing\n{\n    /// <summary>Charges invoices.</summary>\n    public class Billing : IBilling\n    {\n        public int Charge(string id) { return Store.Save(id); }\n        private void Helper() {}\n    }\n    public interface IBilling { int Charge(string id); }\n    public record Invoice(int Total);\n}\n",
    "Db/Store.cs": "namespace Acme.Db;\n\npublic static class Store\n{\n    public static int Save(string id) => 1;\n}\n",
  });
  assert.deepEqual(decls(map, "Billing/Billing.cs"), ["Acme.Billing:namespace:3-13:pub", "Billing:class:6-10:pub", "Billing.Charge:method:8-8:pub", "Billing.Helper:method:9-9", "IBilling:interface:11-11:pub", "IBilling.Charge:method:11-11", "Invoice:class:12-12:pub"]);
  assert.equal(map.file("Billing/Billing.cs")!.d[1].d, "Charges invoices.");
  assert.deepEqual(users(map, "Db/Store.cs", "Store"), ["Billing.Charge@Billing/Billing.cs(guessed)"]);
  assert.deepEqual(users(map, "Billing/Billing.cs", "IBilling"), ["Billing@Billing/Billing.cs"]);
});

test("Ruby: modules, classes, methods under their class; require_relative", async () => {
  const map = await mapOf({
    "lib/billing.rb": 'require_relative "models/invoice"\n\n# Charges invoices.\nmodule Billing\n  class Charger < Base\n    def charge(id)\n      Invoice.find(id)\n    end\n\n    def self.build; end\n  end\nend\n',
    "lib/models/invoice.rb": "# One bill.\nclass Invoice\n  def self.find(id); end\nend\n",
  });
  assert.deepEqual(decls(map, "lib/billing.rb"), ["Billing:namespace:4-12:pub", "Billing.Charger:class:5-11:pub", "Charger.charge:method:6-8:pub", "Charger.build:method:10-10:pub"]);
  assert.equal(map.file("lib/billing.rb")!.d[0].d, "Charges invoices.");
  assert.deepEqual(users(map, "lib/models/invoice.rb", "Invoice"), ["Charger.charge@lib/billing.rb(guessed)"]);
});

test("PHP: classes, interfaces, functions, methods with visibility; use statements by namespace path", async () => {
  const map = await mapOf({
    "app/Billing/Charger.php": "<?php\nnamespace App\\Billing;\n\nuse App\\Models\\Invoice;\n\n/** Charges invoices. */\nclass Charger implements Api\n{\n    public function charge(string $id): int { return Invoice::find($id); }\n    private function helper() {}\n}\n\nfunction topLevel() { return 1; }\ninterface Api {}\n",
    "app/Models/Invoice.php": "<?php\nnamespace App\\Models;\n\nclass Invoice\n{\n    public static function find($id) { return 1; }\n}\n",
  });
  assert.deepEqual(decls(map, "app/Billing/Charger.php"), ["Charger:class:7-11:pub", "Charger.charge:method:9-9:pub", "Charger.helper:method:10-10", "topLevel:function:13-13:pub", "Api:interface:14-14:pub"]);
  assert.equal(map.file("app/Billing/Charger.php")!.d[0].d, "Charges invoices.");
  assert.deepEqual(users(map, "app/Models/Invoice.php", "Invoice"), ["Charger.charge@app/Billing/Charger.php"]);
});

test("a codebase in several languages: one map, one search, tests ranked low", async () => {
  const map = await mapOf({
    "api/handler.go": "package api\n\n// HandleUpload takes a file.\nfunc HandleUpload() {}\n",
    "api/handler_test.go": "package api\n\nfunc TestHandleUpload() {}\n",
    "web/upload.ts": "export function startUpload() {}\n",
    "worker/upload.py": "def process_upload():\n    pass\n",
  });
  const lines = map.find("upload", { limit: 4 }).split("\n");
  assert.equal(lines.length, 4);
  assert.match(lines[3], /handler_test\.go/, "the Go test comes last");
  assert.match(map.overview(), /4 files \(.*go.*\)/);
});
