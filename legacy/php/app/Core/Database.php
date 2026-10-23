<?php

declare(strict_types=1);

final class Database
{
    private static ?MongoDB\Client $client = null;

    public static function connection(array $config): MongoDB\Database
    {
        if (!self::$client instanceof MongoDB\Client) {
            self::$client = new MongoDB\Client($config['uri']);
        }

        $database = self::$client->selectDatabase($config['database']);
        $database->selectCollection('users')->createIndex(['email' => 1], ['unique' => true]);
        $database->selectCollection('users')->createIndex(
            ['student_id' => 1],
            ['unique' => true, 'partialFilterExpression' => ['student_id' => ['$type' => 'string']]],
        );
        $database->selectCollection('item_claims')->createIndex(
            ['item_id' => 1, 'user_id' => 1],
            ['unique' => true],
        );
        $database->selectCollection('lost_items')->createIndex(['status' => 1, 'date_lost' => -1]);
        $database->selectCollection('lost_items')->createIndex(['user_id' => 1, 'created_at' => -1]);
        $database->selectCollection('item_claims')->createIndex(['user_id' => 1, 'created_at' => -1]);

        return $database;
    }
}
