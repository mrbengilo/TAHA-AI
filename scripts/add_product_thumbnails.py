from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(rel, old, new):
    path = ROOT / rel
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{rel}: expected one match, got {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def append_once(rel, marker, block):
    path = ROOT / rel
    text = path.read_text(encoding="utf-8")
    if marker not in text:
        path.write_text(text.rstrip() + "\n\n" + block.strip() + "\n", encoding="utf-8")


replace_once(
    "lib/channel-library.ts",
    '''    db.prepare(
      `SELECT id, name, base_sku, status, updated_at
       FROM products
       WHERE workspace_id = ? AND deleted_at IS NULL AND status != 'archived'
       ORDER BY updated_at DESC
       LIMIT ?`,
    ).bind(TAHA_WORKSPACE_ID, limit).all<Record<string, unknown>>(),''',
    '''    db.prepare(
      `SELECT p.id, p.name, p.base_sku, p.status, p.updated_at,
              (SELECT pm.media_id
               FROM product_media pm
               JOIN media_assets media ON media.id = pm.media_id AND media.workspace_id = pm.workspace_id
               WHERE pm.workspace_id = p.workspace_id AND pm.product_id = p.id
                 AND media.media_type = 'image' AND media.status = 'ready'
               ORDER BY CASE pm.role WHEN 'primary' THEN 0 WHEN 'source' THEN 1 WHEN 'generated' THEN 2 ELSE 3 END,
                        pm.sort_order, pm.created_at
               LIMIT 1) AS primary_media_id
       FROM products p
       WHERE p.workspace_id = ? AND p.deleted_at IS NULL AND p.status != 'archived'
       ORDER BY p.updated_at DESC
       LIMIT ?`,
    ).bind(TAHA_WORKSPACE_ID, limit).all<Record<string, unknown>>(),''',
)

replace_once(
    "lib/channel-library.ts",
    '''  const products = rows(productsResult).map((row) => ({
    id: String(row.id),
    name: String(row.name),
    baseSku: String(row.base_sku),
    status: String(row.status),
    updatedAt: asIso(row.updated_at),
  }));''',
    '''  const products = rows(productsResult).map((row) => ({
    id: String(row.id),
    name: String(row.name),
    baseSku: String(row.base_sku),
    status: String(row.status),
    previewUrl: row.primary_media_id
      ? `/api/media/${encodeURIComponent(String(row.primary_media_id))}/download?inline=1`
      : null,
    updatedAt: asIso(row.updated_at),
  }));''',
)

replace_once(
    "app/channels/[provider]/ChannelWorkspace.tsx",
    '''type ChannelProduct = { id: string; name: string; baseSku: string; status: string };''',
    '''type ChannelProduct = { id: string; name: string; baseSku: string; status: string; previewUrl: string | null };''',
)

replace_once(
    "app/channels/[provider]/ChannelWorkspace.tsx",
    '''<div className="ch-table-wrap"><table><thead><tr><th>Sản phẩm</th><th>SKU</th><th>Trạng thái</th></tr></thead><tbody>{products.map((product) => <tr key={product.id}><td>{product.name}</td><td><code>{product.baseSku}</code></td><td><span className={`ch-content-status is-${product.status}`}>{contentStatusLabel(product.status)}</span></td></tr>)}</tbody></table></div>''',
    '''<div className="ch-table-wrap"><table><thead><tr><th>Ảnh</th><th>Sản phẩm</th><th>SKU</th><th>Trạng thái</th></tr></thead><tbody>{products.map((product) => <tr key={product.id}><td>{product.previewUrl ? <img className="ch-product-thumb" src={product.previewUrl} alt={product.name} loading="lazy" /> : <span className="ch-product-thumb-empty">—</span>}</td><td>{product.name}</td><td><code>{product.baseSku}</code></td><td><span className={`ch-content-status is-${product.status}`}>{contentStatusLabel(product.status)}</span></td></tr>)}</tbody></table></div>''',
)

append_once(
    "app/channels/channels.css",
    ".ch-product-thumb{",
    '''.ch-product-thumb{
  display:block;
  width:58px;
  height:58px;
  object-fit:cover;
  border-radius:12px;
  border:1px solid rgba(15,23,42,.08);
  background:#f3f4f6;
}
.ch-product-thumb-empty{
  display:grid;
  place-items:center;
  width:58px;
  height:58px;
  border-radius:12px;
  background:#f3f4f6;
  color:#94a3b8;
}
''',
)

# Contract test: product rows must expose/render a primary image.
test = ROOT / "tests/taha-e2e-fixes.test.mjs"
text = test.read_text(encoding="utf-8")
block = '''\ntest("product tables expose real primary-image thumbnails", () => {\n  const library = read("lib/channel-library.ts");\n  const ui = read("app/channels/[provider]/ChannelWorkspace.tsx");\n  assert.match(library, /primary_media_id/);\n  assert.match(library, /previewUrl:/);\n  assert.match(ui, /ch-product-thumb/);\n  assert.match(ui, /product\\.previewUrl/);\n});\n'''
if 'test("product tables expose real primary-image thumbnails"' not in text:
    test.write_text(text.rstrip() + "\n" + block, encoding="utf-8")

print("Product thumbnails patch applied")
