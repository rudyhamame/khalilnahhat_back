# Gallery albums

Gallery albums contain references to existing `MediaItem` photo/video IDs.
An asset may appear in several albums. Removing album membership or deleting an
album does not delete the asset or its stored file. Deleting an asset from Gallery
continues to remove its Gallery record; album lists ignore missing asset records.

## API

All writes and the admin listing require the existing admin session.

| Method | Path under `/api/content/gallery/albums` | Action |
| --- | --- | --- |
| GET | `/` | Published Gallery assets grouped into albums |
| GET | `/admin` | Albums including unpublished asset memberships |
| POST | `/` | Create `{name, nameAr?, description?}` |
| PATCH | `/:id` | Edit album details |
| DELETE | `/:id` | Delete album; preserve Gallery assets |
| POST | `/:id/items` | Add `{itemIds: [...]}`; up to 500 per request |
| DELETE | `/:id/items/:itemId` | Remove one album membership |

Albums return `id`, `name`, `nameAr`, `description`, `itemIds`, `count`, and
`coverUrl` on list endpoints. Public lists exclude unpublished assets and their
IDs. A deleted album is retained as a tombstone so concurrent assignments cannot
restore it or hide assets in a deleted collection.

## Equipment artwork

The first album request creates Equipment and imports existing photos identified
by `category: equipment`, the artwork importer's title suffix, or an equipment
entry's current artwork URL. A persistent `ContentSeed` marker prevents the
migration from running again after a deliberate album deletion.

New equipment artwork is assigned when its Gallery media record is created.
The local equipment artwork importer also resolves/creates Equipment and assigns
each imported image, including existing Gallery records reused on a retry.

Deployment of the backend is required before the hosted API can serve these
endpoints. The frontend retains flat Gallery access and shows an admin message
if album endpoints return HTTP 404. The importer can continue registering artwork
on an older backend; the migration groups it after this backend update is deployed.

## Admin workflow

- Albums sidebar: All assets, Unfiled, custom albums, and New album.
- Album tools: edit name/description, delete album, or add existing Gallery assets.
- Uploads while viewing an album are added directly to that album.
- Select assets to add them to another album or remove their current membership.
- Edit an asset's title, Arabic title, public visibility, and album memberships.
- Public Gallery and Gallery image pickers offer album filtering.

No live migration or deployment is performed by editing these source files.
