<?php

declare(strict_types=1);

final class LostItem
{
    private MongoDB\Database $db;

    public function __construct(MongoDB\Database $db)
    {
        $this->db = $db;
    }

    public function create(string $userId, array $input): array
    {
        $itemId = $this->uuid();
        $parameters = $this->parameters($userId, $input);
        $parameters['image_path'] = ($parameters['item_type'] === 'lost')
            ? $this->storeLostImage($input['image'] ?? null, $itemId)
            : null;
        $now = date('Y-m-d H:i:s');
        $this->db->selectCollection('lost_items')->insertOne(array_merge($parameters, [
            '_id' => $itemId,
            'created_at' => $now,
            'updated_at' => $now,
        ]));
        return $this->findOne($userId, $itemId);
    }

    public function findForUser(string $userId): array
    {
        $documents = $this->db->selectCollection('lost_items')->find(
            ['user_id' => $userId],
            ['sort' => ['created_at' => -1]],
        );
        return array_map(fn (object $document): array => $this->normalizeItem($document), iterator_to_array($documents, false));
    }

    public function update(string $userId, string $itemId, array $input): array
    {
        $parameters = $this->parameters($userId, $input);
        unset($parameters['user_id'], $parameters['item_type'], $parameters['status']);
        $result = $this->db->selectCollection('lost_items')->updateOne([
            '_id' => $itemId,
            'user_id' => $userId,
            'status' => ['$in' => ['lost', 'found']],
        ], ['$set' => array_merge($parameters, ['updated_at' => date('Y-m-d H:i:s')])]);
        if ($result->getMatchedCount() === 0) {
            throw new RuntimeException('Editable report was not found.');
        }

        return $this->findOne($userId, $itemId);
    }

    public function cancel(string $userId, string $itemId): void
    {
        $result = $this->db->selectCollection('lost_items')->updateOne([
            '_id' => $itemId,
            'user_id' => $userId,
            'status' => ['$in' => ['lost', 'found']],
        ], ['$set' => ['status' => 'cancelled', 'updated_at' => date('Y-m-d H:i:s')]]);
        if ($result->getMatchedCount() === 0) {
            throw new RuntimeException('Only an active report can be cancelled.');
        }
    }

    public function search(array $filters, ?string $userId = null): array
    {
        $filter = ['status' => ['$in' => ['lost', 'found']]];
        $query = trim((string) ($filters['query'] ?? ''));
        if ($query !== '') {
            $regex = new MongoDB\BSON\Regex(preg_quote($query), 'i');
            $filter['$or'] = array_map(
                static fn (string $field): array => [$field => $regex],
                ['item_name', 'description', 'identifying_details', 'category', 'location'],
            );
        }
        foreach (['category', 'location', 'status', 'item_type'] as $field) {
            $value = trim((string) ($filters[$field] ?? ''));
            if ($value !== '') {
                $filter[$field] = new MongoDB\BSON\Regex(preg_quote($value), 'i');
            }
        }
        $dateFilter = [];
        if (($filters['date_from'] ?? '') !== '') {
            $dateFilter['$gte'] = (string) $filters['date_from'];
        }
        if (($filters['date_to'] ?? '') !== '') {
            $dateFilter['$lte'] = (string) $filters['date_to'];
        }
        if ($dateFilter) {
            $filter['date_lost'] = $dateFilter;
        }

        $documents = $this->db->selectCollection('lost_items')->find($filter, ['sort' => ['date_lost' => -1, 'created_at' => -1]]);
        $users = $this->db->selectCollection('users');
        $claims = $this->db->selectCollection('item_claims');
        $items = [];
        foreach ($documents as $document) {
            $item = $this->normalizeItem($document);
            $reporter = $users->findOne(['_id' => $item['user_id']], ['projection' => ['full_name' => 1]]);
            $item['reported_by'] = $reporter['full_name'] ?? 'Unknown';
            $item['user_claim_id'] = $userId === null ? null : ($claims->findOne(
                ['item_id' => $item['id'], 'user_id' => $userId],
                ['projection' => ['_id' => 1]],
            )['_id'] ?? null);
            $items[] = $item;
        }
        return $items;
    }

    public function createClaim(string $userId, array $input): array
    {
        $itemId = trim((string) ($input['item_id'] ?? ''));
        $details = trim((string) ($input['claim_details'] ?? ''));
        if ($itemId === '' || $details === '') {
            throw new RuntimeException('Select an item and provide ownership details.');
        }
        $itemDocument = $this->db->selectCollection('lost_items')->findOne([
            '_id' => $itemId,
            'status' => ['$in' => ['lost', 'found']],
        ], ['projection' => ['user_id' => 1]]);
        $item = $itemDocument ? (array) $itemDocument : null;
        if (!$item) {
            throw new RuntimeException('That item is no longer available for claims.');
        }
        if ((string) $item['user_id'] === $userId) {
            throw new RuntimeException('You cannot claim your own report.');
        }
        $claims = $this->db->selectCollection('item_claims');
        if ($claims->findOne(['item_id' => $itemId, 'user_id' => $userId])) {
            throw new RuntimeException('You have already submitted a claim for this item.');
        }
        $claimId = $this->uuid();
        try {
            $claims->insertOne([
                '_id' => $claimId,
                'item_id' => $itemId,
                'user_id' => $userId,
                'claim_details' => $details,
                'status' => 'pending',
                'created_at' => date('Y-m-d H:i:s'),
                'updated_at' => date('Y-m-d H:i:s'),
            ]);
        } catch (MongoDB\Driver\Exception\Exception $exception) {
            if ($exception->getCode() === 11000) {
                throw new RuntimeException('You have already submitted a claim for this item.');
            }
            throw $exception;
        }
        return $this->findClaim($userId, $claimId);
    }

    public function findClaimsForUser(string $userId): array
    {
        $documents = $this->db->selectCollection('item_claims')->find(['user_id' => $userId], ['sort' => ['created_at' => -1]]);
        $items = $this->db->selectCollection('lost_items');
        $result = [];
        foreach ($documents as $document) {
            $claim = $this->documentArray($document);
            $itemDocument = $items->findOne(['_id' => $claim['item_id']]);
            if ($itemDocument) {
                $item = $this->normalizeItem($itemDocument);
                $result[] = array_merge($claim, [
                    'item_name' => $item['item_name'],
                    'item_type' => $item['item_type'],
                    'category' => $item['category'],
                    'location' => $item['location'],
                ]);
            }
        }
        return $result;
    }

    public function findPublic(string $itemId, string $userId): array
    {
        $document = $this->db->selectCollection('lost_items')->findOne([
            '_id' => $itemId,
            'status' => ['$in' => ['lost', 'found']],
        ]);
        $item = $document ? $this->normalizeItem($document) : null;
        if (!$item) {
            throw new RuntimeException('Item was not found or is no longer available.');
        }
        $reporter = $this->db->selectCollection('users')->findOne(['_id' => $item['user_id']], ['projection' => ['full_name' => 1]]);
        $claims = $this->db->selectCollection('item_claims');
        $claim = $claims->findOne(['item_id' => $itemId, 'user_id' => $userId], ['projection' => ['_id' => 1]]);
        $item['reported_by'] = $reporter['full_name'] ?? 'Unknown';
        $item['total_claims'] = $claims->countDocuments(['item_id' => $itemId]);
        $item['user_claim_id'] = $claim ? (string) $claim['_id'] : null;
        unset($item['identifying_details']);
        return $item;
    }

    private function findOne(string $userId, string $itemId): array
    {
        $document = $this->db->selectCollection('lost_items')->findOne(['_id' => $itemId, 'user_id' => $userId]);
        $item = $document ? $this->normalizeItem($document) : null;
        if (!$item) {
            throw new RuntimeException('Lost report was not found.');
        }
        return $item;
    }

    private function parameters(string $userId, array $input): array
    {
        $dateLost = trim((string) ($input['date_lost'] ?? ''));
        $values = [
            'user_id' => $userId,
            'item_type' => in_array(($input['item_type'] ?? 'lost'), ['lost', 'found'], true) ? $input['item_type'] : 'lost',
            'status' => ($input['item_type'] ?? 'lost') === 'found' ? 'found' : 'lost',
            'item_name' => trim((string) ($input['item_name'] ?? '')),
            'description' => trim((string) ($input['description'] ?? '')),
            'identifying_details' => trim((string) ($input['identifying_details'] ?? '')),
            'category' => trim((string) ($input['category'] ?? '')),
            'location' => trim((string) ($input['location'] ?? '')),
            'date_lost' => $dateLost,
        ];

        if (in_array('', $values, true)) {
            throw new RuntimeException('All lost-item details are required.');
        }
        $date = DateTimeImmutable::createFromFormat('!Y-m-d', $dateLost);
        if (!$date || $date->format('Y-m-d') !== $dateLost || $dateLost > date('Y-m-d')) {
            throw new RuntimeException('The item date must be today or an earlier date.');
        }
        return $values;
    }

    private function findClaim(string $userId, string $claimId): array
    {
        $document = $this->db->selectCollection('item_claims')->findOne(['_id' => $claimId, 'user_id' => $userId]);
        $claim = $document ? $this->documentArray($document) : null;
        if (!$claim) {
            throw new RuntimeException('Claim was not found.');
        }
        return $claim;
    }

    private function normalizeItem(object $document): array
    {
        $item = $this->documentArray($document);
        if ($item['status'] !== 'cancelled') {
            $item['status'] = $item['item_type'];
        }
        return $item;
    }

    private function documentArray(object $document): array
    {
        $values = iterator_to_array($document);
        if (isset($values['_id'])) {
            $values['id'] = (string) $values['_id'];
            unset($values['_id']);
        }
        return $values;
    }

    private function storeLostImage($file, string $itemId): ?string
    {
        if (!is_array($file) || ($file['error'] ?? UPLOAD_ERR_NO_FILE) === UPLOAD_ERR_NO_FILE) {
            return null;
        }
        if (($file['error'] ?? UPLOAD_ERR_OK) !== UPLOAD_ERR_OK) {
            throw new RuntimeException('The image upload failed. Please try again.');
        }
        if (($file['size'] ?? 0) > 5 * 1024 * 1024 || !is_uploaded_file((string) ($file['tmp_name'] ?? ''))) {
            throw new RuntimeException('The image must be 5 MB or smaller.');
        }

        $mime = (new finfo(FILEINFO_MIME_TYPE))->file((string) $file['tmp_name']);
        $extensions = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'image/webp' => 'webp'];
        if (!isset($extensions[$mime])) {
            throw new RuntimeException('Upload a JPG, PNG, or WEBP image.');
        }

        $filename = $itemId . '.' . $extensions[$mime];
        $directory = dirname(__DIR__, 2) . '/uploads/lost';
        if (!is_dir($directory) && !mkdir($directory, 0755, true) && !is_dir($directory)) {
            throw new RuntimeException('The image upload directory is unavailable.');
        }
        if (!move_uploaded_file((string) $file['tmp_name'], $directory . '/' . $filename)) {
            throw new RuntimeException('The image could not be saved.');
        }
        return 'uploads/lost/' . $filename;
    }

    private function uuid(): string
    {
        $bytes = random_bytes(16);
        $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
        $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($bytes), 4));
    }
}