<?php

declare(strict_types=1);

session_start([
    'cookie_httponly' => true,
    'cookie_samesite' => 'Lax',
    'cookie_secure' => isset($_SERVER['HTTPS']),
]);

$config = require __DIR__ . '/config.php';
if (!extension_loaded('mongodb') || !is_file(__DIR__ . '/vendor/autoload.php')) {
    http_response_code(503);
    exit('MongoDB setup required: enable the MongoDB PHP extension for XAMPP and run composer install.');
}
require_once __DIR__ . '/vendor/autoload.php';
require_once __DIR__ . '/app/Core/Database.php';
require_once __DIR__ . '/app/Services/Auth.php';
require_once __DIR__ . '/app/Services/LostItem.php';

$db = Database::connection($config['mongodb']);
$auth = new Auth($db);
$lostItems = new LostItem($db);

if (!function_exists('currentUser')) {
    function currentUser(): ?array
    {
        return $_SESSION['user'] ?? null;
    }
}

if (!function_exists('requireUser')) {
    function requireUser(Auth $auth, array $roles = ['user', 'staff', 'admin']): array
    {
        $user = currentUser();
        if (!$user || !isset($user['id'], $user['role_name'])) {
            header('Location: index.php?page=login');
            exit;
        }
        $auth->requireRole($user, $roles);
        return $user;
    }
}

if (!function_exists('e')) {
    function e($value): string
    {
        return htmlspecialchars((string) $value, ENT_QUOTES, 'UTF-8');
    }
}

if (!function_exists('redirect')) {
    function redirect(string $location): void
    {
        header("Location: {$location}");
        exit;
    }
}