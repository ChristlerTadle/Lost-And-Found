<?php

declare(strict_types=1);

$page = (string) ($_GET['page'] ?? 'landing');

if ($page === 'landing' && $_SERVER['REQUEST_METHOD'] === 'GET') {
    if (!function_exists('e')) {
        function e(mixed $value): string
        {
            return htmlspecialchars((string) $value, ENT_QUOTES, 'UTF-8');
        }
    }
    require __DIR__ . '/views/layout.php';
    require __DIR__ . '/views/landing.php';
    exit;
}

require __DIR__ . '/bootstrap.php';
require __DIR__ . '/views/layout.php';

if (isset($_GET['logout'])) {
    $_SESSION = [];
    session_destroy();
    redirect('index.php');
}

$error = null;
$message = null;

try {
    if ($page === 'login') {
        if ($_SERVER['REQUEST_METHOD'] === 'POST') {
            $input = $_POST;
            if (($input['action'] ?? '') === 'register') {
                $_SESSION['user'] = $auth->register($input);
            } else {
                session_regenerate_id(true);
                $_SESSION['user'] = $auth->login((string) ($input['email'] ?? ''), (string) ($input['password'] ?? ''));
            }
            redirect('index.php?page=dashboard');
        }
        require __DIR__ . '/views/login.php';
        exit;
    }

    $user = requireUser($auth);

    if ($page === 'profile') {
        $items = $lostItems->findForUser($user['id']);
        $claims = $lostItems->findClaimsForUser($user['id']);
        if ($_SERVER['REQUEST_METHOD'] === 'POST') {
            $_SESSION['user'] = array_merge($user, $auth->updateProfile($user['id'], $_POST));
            $user = $_SESSION['user'];
            $message = 'Profile updated successfully.';
        }
        require __DIR__ . '/views/profile.php';
        exit;
    }

    if ($page === 'report') {
        if ($_SERVER['REQUEST_METHOD'] === 'POST') {
            $auth->requireRole($user, ['user']);
            $_POST['item_type'] = (string) ($_GET['kind'] ?? 'lost');
            $lostItems->create($user['id'], array_merge($_POST, ['image' => $_FILES['image'] ?? null]));
            redirect('index.php?page=reports');
        }
        require __DIR__ . ((string) ($_GET['kind'] ?? 'lost') === 'found'
            ? '/views/report_found.php'
            : '/views/report_lost.php');
        exit;
    }

    if ($page === 'reports') {
        $auth->requireRole($user, ['user']);
        if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($_POST['action'] ?? '') === 'edit_report') {
            $lostItems->update($user['id'], (string) $_POST['id'], $_POST);
            $message = 'Report updated successfully.';
        }
        if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($_POST['action'] ?? '') === 'cancel_report') {
            $lostItems->cancel($user['id'], (string) $_POST['id']);
            $message = 'Report cancelled.';
        }
        $items = $lostItems->findForUser($user['id']);
        $editItem = null;
        if (isset($_GET['edit'])) {
            foreach ($items as $item) {
                if ((string) $item['id'] === (string) $_GET['edit']) {
                    $editItem = $item;
                    break;
                }
            }
        }
        require __DIR__ . '/views/reports.php';
        exit;
    }

    if ($page === 'items') {
        $items = $lostItems->search($_GET, $user['id']);
        require __DIR__ . '/views/items.php';
        exit;
    }

    if ($page === 'item') {
        $item = $lostItems->findPublic((string) ($_GET['id'] ?? ''), $user['id']);
        require __DIR__ . '/views/item.php';
        exit;
    }

    if ($page === 'claim') {
        $auth->requireRole($user, ['user']);
        if ($_SERVER['REQUEST_METHOD'] === 'POST') {
            $lostItems->createClaim($user['id'], $_POST);
            redirect('index.php?page=claims');
        }
        $itemId = (string) ($_GET['item'] ?? '');
        $item = null;
        foreach ($lostItems->search([]) as $candidate) {
            if ((string) $candidate['id'] === $itemId) {
                $item = $candidate;
                break;
            }
        }
        if (!$item) {
            throw new RuntimeException('Item was not found.');
        }
        require __DIR__ . '/views/claim.php';
        exit;
    }

    if ($page === 'claims') {
        $auth->requireRole($user, ['user']);
        $claims = $lostItems->findClaimsForUser($user['id']);
        require __DIR__ . '/views/claims.php';
        exit;
    }

    if ($page === 'dashboard') {
        $auth->requireRole($user, ['user']);
        $items = $lostItems->findForUser($user['id']);
        $claims = $lostItems->findClaimsForUser($user['id']);
        require __DIR__ . '/views/dashboard.php';
        exit;
    }

    redirect('index.php');
} catch (Throwable $exception) {
    $error = $exception->getMessage();
    if ($page === 'login') {
        require __DIR__ . '/views/login.php';
    } elseif ($page === 'profile') {
        require __DIR__ . '/views/profile.php';
    } elseif ($page === 'report') {
        require __DIR__ . ((string) ($_GET['kind'] ?? 'lost') === 'found'
            ? '/views/report_found.php'
            : '/views/report_lost.php');
    } elseif ($page === 'items') {
        $items = [];
        require __DIR__ . '/views/items.php';
    } elseif ($page === 'claim') {
        $item = $item ?? null;
        require __DIR__ . '/views/claim.php';
    } elseif ($page === 'claims') {
        $claims = [];
        require __DIR__ . '/views/claims.php';
    } else {
        $user = currentUser();
        $items = $user ? $lostItems->findForUser($user['id']) : [];
        $editItem = null;
        require __DIR__ . '/views/reports.php';
    }
}
