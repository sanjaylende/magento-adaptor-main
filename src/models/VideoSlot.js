// EAV entity "video_slot": one per (product uniqueTag, videoType). Its child entities are the slot's video_version rows;
// currentVersionId points at the one the UI shows.
module.exports = {
  entityType: "video_slot",
  label: "Video Slot",
  attributes: {
    uniqueTag: { backend: "varchar", frontend: "string" },
    videoType: { backend: "varchar", frontend: "string" },
    currentVersionId: { backend: "int", frontend: "int" },
  },
};
