<?php

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

require dirname(__DIR__) . '/vendor/autoload.php';
require dirname(__DIR__) . '/app/Core/Database.php';

$config = require dirname(__DIR__) . '/config.php';
$source = $config['mysql_source'];
$mysql = new PDO($source['dsn'], $source['username'], $source['password'], [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
]);
$mongo = Database::connection($config['mongodb']);

$roleNames = [];
foreach ($mysql->query('SELECT id, role_name FROM roles')->fetchAll() as $role) {
    $roleNames[(string) $role['id']] = $role['role_name'];
}

$userCollection = $mongo->selectCollection('users');
$userCount = 0;
foreach ($mysql->query('SELECT * FROM users')->fetchAll() as $user) {
    $legacyId = (string) $user['id'];
    $roleId = (string) $user['role_id'];
    unset($user['id'], $user['role_id']);
    $user['_id'] = $legacyId;
    $user['role_name'] = $roleNames[$roleId] ?? 'user';
    $userCollection->replaceOne(['_id' => $legacyId], $user, ['upsert' => true]);
    $userCount++;
}

$itemCollection = $mongo->selectCollection('lost_items');
$itemCount = 0;
foreach ($mysql->query('SELECT * FROM lost_items')->fetchAll() as $item) {
    $legacyId = (string) $item['id'];
    unset($item['id']);
    $item['_id'] = $legacyId;
    $item['item_type'] = in_array($item['item_type'] ?? null, ['lost', 'found'], true) ? $item['item_type'] : 'lost';
    if (($item['status'] ?? '') === 'lost' && $item['item_type'] === 'found') {
        $item['status'] = 'found';
    }
    $item['image_path'] = $item['image_path'] ?? null;
    $itemCollection->replaceOne(['_id' => $legacyId], $item, ['upsert' => true]);
    $itemCount++;
}

$claimCount = 0;
try {
    $claimCollection = $mongo->selectCollection('item_claims');
    foreach ($mysql->query('SELECT * FROM item_claims')->fetchAll() as $claim) {
        $legacyId = (string) $claim['id'];
        unset($claim['id']);
        $claim['_id'] = $legacyId;
        $claimCollection->replaceOne(['_id' => $legacyId], $claim, ['upsert' => true]);
        $claimCount++;
    }
} catch (PDOException $exception) {
    if ($exception->getCode() !== '42S02' && $exception->getCode() !== '1146') {
        throw $exception;
    }
}

printf("Imported or updated %d users, %d item reports, and %d claims.\n", $userCount, $itemCount, $claimCount);
printf("Source MySQL data was not changed or deleted. MongoDB database: %s\n", $config['mongodb']['database']);
