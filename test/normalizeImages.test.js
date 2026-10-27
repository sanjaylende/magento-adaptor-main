// Products with several gallery images: how Magento's media_gallery_entries become the adapter's image list.
const test = require("node:test");
const assert = require("node:assert/strict");
const { pickImages, pickImage, normalizeProduct, normalizeProducts } = require("../src/utils/normalize");

const BASE = "https://shop.example";
const entry = (file, extra = {}) => ({ id: 1, file, position: 1, disabled: false, types: [], media_type: "image", ...extra });
const gallery = (n) => Array.from({ length: n }, (_, i) => entry(`/p/r/product-${i + 1}.jpg`, { id: i + 1, position: i + 1, types: i === 0 ? ["image", "small_image", "thumbnail"] : [] }));

test("seven gallery images become seven addresses, in the store's order, under the store's media folder", () => {
  const urls = pickImages({ media_gallery_entries: gallery(7) }, BASE);
  assert.equal(urls.length, 7);
  assert.deepEqual(urls, Array.from({ length: 7 }, (_, i) => `${BASE}/media/catalog/product/p/r/product-${i + 1}.jpg`));
});

test("the first image is the product picture, whatever the others are", () => {
  assert.equal(pickImage({ media_gallery_entries: gallery(7) }, BASE), `${BASE}/media/catalog/product/p/r/product-1.jpg`);
});

test("one image, none, and a product that has no gallery field at all", () => {
  assert.equal(pickImages({ media_gallery_entries: gallery(1) }, BASE).length, 1);
  assert.deepEqual(pickImages({ media_gallery_entries: [] }, BASE), []);
  assert.deepEqual(pickImages({}, BASE), []);
  assert.deepEqual(pickImages({ media_gallery_entries: null }, BASE), []);
  assert.equal(pickImage({}, BASE), null);
});

test("an entry without a file is skipped and the rest keep their order", () => {
  const entries = [entry("/a.jpg"), entry(null), entry(""), { id: 9 }, entry("/b.jpg")];
  assert.deepEqual(pickImages({ media_gallery_entries: entries }, BASE), [`${BASE}/media/catalog/product/a.jpg`, `${BASE}/media/catalog/product/b.jpg`]);
});

test("a long gallery (25 images) is returned whole", () => {
  assert.equal(pickImages({ media_gallery_entries: gallery(25) }, BASE).length, 25);
});

test("the media folder can be a different host than the store (a CDN)", () => {
  assert.equal(pickImages({ media_gallery_entries: gallery(2) }, "https://cdn.example")[1], "https://cdn.example/media/catalog/product/p/r/product-2.jpg");
});

test("a normalized product carries every image and uses the first as its picture", () => {
  const p = normalizeProduct({ id: 1, sku: "A", name: "Apples", price: 10, type_id: "simple", media_gallery_entries: gallery(7), custom_attributes: [] }, null, { category: "Fruits", mediaBaseUrl: BASE, currencyCode: "USD" });
  assert.equal(p.images.length, 7);
  assert.equal(p.image, p.images[0]);
  assert.ok(p.images.every((u) => u.startsWith(BASE + "/media/catalog/product/")));
});

test("a configurable product keeps its OWN gallery (not its child's), however many images each has", () => {
  const parent = { id: 2, sku: "CFG", name: "Shirt", price: 0, type_id: "configurable", media_gallery_entries: gallery(7), custom_attributes: [] };
  const child = { id: 3, sku: "CFG-S", name: "Shirt S", price: 20, type_id: "simple", media_gallery_entries: [entry("/c/h/child.jpg")], custom_attributes: [] };
  const p = normalizeProduct(parent, child, { category: "Shirts", mediaBaseUrl: BASE, currencyCode: "USD" });
  assert.equal(p.images.length, 7, "the parent's seven photos, not the single photo of the child");
});

test("products with different numbers of images are all kept and listed independently", async () => {
  const products = [
    { id: 1, sku: "A", name: "One", status: 1, visibility: 4, price: 5, type_id: "simple", media_gallery_entries: gallery(1), custom_attributes: [] },
    { id: 2, sku: "B", name: "Seven", status: 1, visibility: 4, price: 6, type_id: "simple", media_gallery_entries: gallery(7), custom_attributes: [] },
    { id: 3, sku: "C", name: "TwentyFive", status: 1, visibility: 4, price: 7, type_id: "simple", media_gallery_entries: gallery(25), custom_attributes: [] },
    { id: 4, sku: "D", name: "None", status: 1, visibility: 4, price: 8, type_id: "simple", media_gallery_entries: [], custom_attributes: [] },
  ];
  const list = await normalizeProducts(products, async () => ({ child: null, children: [], category: "Misc", mediaBaseUrl: BASE }), { currencyCode: "USD" });
  assert.deepEqual(list.map((p) => [p.name, p.images.length]), [["One", 1], ["Seven", 7], ["TwentyFive", 25], ["None", 0]]);
  assert.equal(list[3].image, null);
});
