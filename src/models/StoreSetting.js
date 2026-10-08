// EAV entity "store_setting": per-store configuration that merchants may tune (one entity per store).
module.exports = {
  entityType: "store_setting",
  label: "Store Setting",
  attributes: {
    categoryAttributeCode: { backend: "varchar", frontend: "string" },
    mediaBaseUrl: { backend: "text", frontend: "string" },
    currencyCode: { backend: "varchar", frontend: "string" },
    categoryThemes: { backend: "text", frontend: "json" },
  },
};
