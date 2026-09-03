<?php
/** Spaces = folders for organising videos inside a workspace. */
final class SpaceController
{
    public static function index(): void
    {
        $wsId = Auth::workspaceId();
        Permissions::requireMember($wsId, 'viewer');
        $rows = Db::all(
            'SELECT s.*, (SELECT COUNT(*) FROM videos v WHERE v.space_id = s.id AND v.deleted_at IS NULL) AS video_count
             FROM spaces s WHERE s.workspace_id = ? ORDER BY s.name ASC',
            [$wsId]
        );
        $spaces = array_map(static fn(array $s) => [
            'id'          => (int)$s['id'],
            'parent_id'   => $s['parent_id'] !== null ? (int)$s['parent_id'] : null,
            'name'        => $s['name'],
            'color'       => $s['color'],
            'is_private'  => (int)$s['is_private'] === 1,
            'video_count' => (int)$s['video_count'],
        ], $rows);
        Http::ok(['spaces' => $spaces]);
    }

    public static function create(): void
    {
        $wsId = Auth::workspaceId();
        $user = Permissions::requireMember($wsId, 'member');
        $name = Http::str('name');
        if ($name === '') {
            Http::fail('Give the space a name.');
        }
        $parentId = Http::int('parent_id') ?: null;
        if ($parentId && !Db::value('SELECT id FROM spaces WHERE id = ? AND workspace_id = ?', [$parentId, $wsId])) {
            $parentId = null;
        }
        $id = Db::insert('spaces', [
            'workspace_id' => $wsId,
            'parent_id'    => $parentId,
            'name'         => mb_substr($name, 0, 150),
            'color'        => preg_match('/^#[0-9a-fA-F]{6}$/', Http::str('color')) ? Http::str('color') : '#625df5',
            'is_private'   => Http::bool('is_private') ? 1 : 0,
            'created_by'   => (int)$user['id'],
            'created_at'   => Util::now(),
        ]);
        Http::ok(['id' => $id]);
    }

    public static function update(): void
    {
        $wsId = Auth::workspaceId();
        Permissions::requireMember($wsId, 'member');
        $id = Http::int('id');
        if (!Db::value('SELECT id FROM spaces WHERE id = ? AND workspace_id = ?', [$id, $wsId])) {
            Http::fail('Space not found.', 404);
        }
        $data = [];
        if (Http::str('name') !== '') {
            $data['name'] = mb_substr(Http::str('name'), 0, 150);
        }
        if (preg_match('/^#[0-9a-fA-F]{6}$/', Http::str('color'))) {
            $data['color'] = Http::str('color');
        }
        if (Http::input('is_private') !== null) {
            $data['is_private'] = Http::bool('is_private') ? 1 : 0;
        }
        if ($data) {
            Db::update('spaces', $data, 'id = ?', [$id]);
        }
        Http::ok();
    }

    public static function delete(): void
    {
        $wsId = Auth::workspaceId();
        Permissions::requireMember($wsId, 'member');
        $id = Http::int('id');
        if (!Db::value('SELECT id FROM spaces WHERE id = ? AND workspace_id = ?', [$id, $wsId])) {
            Http::fail('Space not found.', 404);
        }
        // Videos and child spaces move up to the workspace root rather than being deleted.
        Db::run('UPDATE videos SET space_id = NULL WHERE space_id = ?', [$id]);
        Db::run('UPDATE spaces SET parent_id = NULL WHERE parent_id = ?', [$id]);
        Db::run('DELETE FROM spaces WHERE id = ?', [$id]);
        Http::ok();
    }
}
