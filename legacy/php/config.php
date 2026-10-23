<?php

declare(strict_types=1);

return [
    'mongodb' => [
        'uri' => getenv('MONGODB_URI') ?: 'mongodb://127.0.0.1:27017',
        'database' => getenv('MONGODB_DATABASE') ?: 'lost_and_found',
    ],
    'mysql_source' => [
        'dsn' => getenv('MYSQL_SOURCE_DSN') ?: 'mysql:host=127.0.0.1;port=3306;dbname=lost_and_found;charset=utf8mb4',
        'username' => getenv('MYSQL_SOURCE_USER') ?: 'root',
        'password' => getenv('MYSQL_SOURCE_PASSWORD') ?: '',
    ],
];
