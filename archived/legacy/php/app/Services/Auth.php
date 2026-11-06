<?php

declare(strict_types=1);

final class Auth
{
    private MongoDB\Database $db;

    public function __construct(MongoDB\Database $db)
    {
        $this->db = $db;
    }

    public function register(array $input): array
    {
        $email = strtolower(trim((string) ($input['email'] ?? '')));
        $password = (string) ($input['password'] ?? '');
        $fullName = trim((string) ($input['full_name'] ?? ''));

        if (!filter_var($email, FILTER_VALIDATE_EMAIL) || strlen($password) < 8 || $fullName === '') {
            throw new RuntimeException('Enter a valid name, email, and password of at least 8 characters.');
        }

        $userId = $this->uuid();
        $now = date('Y-m-d H:i:s');
        try {
            $this->db->selectCollection('users')->insertOne([
            '_id' => $userId,
            'email' => $email,
            'password_hash' => password_hash($password, PASSWORD_DEFAULT),
            'full_name' => $fullName,
            'student_id' => $this->nullable($input['student_id'] ?? null),
            'phone' => $this->nullable($input['phone'] ?? null),
            'role_name' => 'user',
            'status' => 'active',
            'created_at' => $now,
            'updated_at' => $now,
            ]);
        } catch (MongoDB\Driver\Exception\Exception $exception) {
            if ($exception->getCode() === 11000) {
                throw new RuntimeException('An account with that email or student ID already exists.');
            }
            throw $exception;
        }

        return $this->findUser($userId);
    }

    public function login(string $email, string $password): array
    {
        $document = $this->db->selectCollection('users')->findOne(['email' => strtolower(trim($email))]);
        $user = $document ? $this->toArray($document) : null;

        if (!$user || $user['status'] !== 'active' || !password_verify($password, $user['password_hash'])) {
            throw new RuntimeException('Invalid credentials.');
        }

        unset($user['password_hash']);
        return $user;
    }

    public function updateProfile(string $userId, array $input): array
    {
        $fullName = trim((string) ($input['full_name'] ?? ''));
        if ($fullName === '') {
            throw new RuntimeException('Full name is required.');
        }
        $this->db->selectCollection('users')->updateOne([
            '_id' => $userId,
            'status' => 'active',
        ], ['$set' => [
            'full_name' => trim((string) ($input['full_name'] ?? '')),
            'phone' => $this->nullable($input['phone'] ?? null),
            'updated_at' => date('Y-m-d H:i:s'),
        ]]);

        return $this->findUser($userId);
    }

    public function requireRole(array $user, array $roles): void
    {
        if (!in_array($user['role_name'] ?? null, $roles, true)) {
            throw new RuntimeException('You do not have permission to perform this action.', 403);
        }
    }

    private function findUser(string $userId): array
    {
        $document = $this->db->selectCollection('users')->findOne(['_id' => $userId]);
        $user = $document ? $this->toArray($document) : null;
        if (!$user) {
            throw new RuntimeException('User was not found.');
        }
        unset($user['password_hash']);
        return $user;
    }

    private function toArray(object $document): array
    {
        $user = iterator_to_array($document);
        if (isset($user['_id'])) {
            $user['id'] = (string) $user['_id'];
            unset($user['_id']);
        }
        return $user;
    }

    private function nullable($value): ?string
    {
        $value = trim((string) ($value ?? ''));
        return $value === '' ? null : $value;
    }

    private function uuid(): string
    {
        $bytes = random_bytes(16);
        $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
        $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($bytes), 4));
    }
}