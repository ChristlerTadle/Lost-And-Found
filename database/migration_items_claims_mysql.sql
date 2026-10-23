-- Run once against an existing MVP database before using found reports and claims.
USE lost_and_found;

SET @has_item_type = (
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'lost_items'
      AND COLUMN_NAME = 'item_type'
);
SET @add_item_type = IF(
    @has_item_type = 0,
    'ALTER TABLE lost_items ADD COLUMN item_type ENUM(''lost'', ''found'') NOT NULL DEFAULT ''lost'' AFTER user_id',
    'SELECT 1'
);
PREPARE add_item_type FROM @add_item_type;
EXECUTE add_item_type;
DEALLOCATE PREPARE add_item_type;

SET @has_image_path = (
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'lost_items'
      AND COLUMN_NAME = 'image_path'
);
SET @add_image_path = IF(
    @has_image_path = 0,
    'ALTER TABLE lost_items ADD COLUMN image_path VARCHAR(255) NULL AFTER date_lost',
    'SELECT 1'
);
PREPARE add_image_path FROM @add_image_path;
EXECUTE add_image_path;
DEALLOCATE PREPARE add_image_path;

ALTER TABLE lost_items
    MODIFY COLUMN status ENUM('lost', 'found', 'cancelled', 'claimed') NOT NULL DEFAULT 'lost';

UPDATE lost_items
SET status = 'found'
WHERE item_type = 'found' AND status = 'lost';

CREATE TABLE IF NOT EXISTS item_claims (
    id CHAR(36) NOT NULL,
    item_id CHAR(36) NOT NULL,
    user_id CHAR(36) NOT NULL,
    claim_details TEXT NOT NULL,
    status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY item_claims_item_user_unique (item_id, user_id),
    KEY item_claims_user_id_idx (user_id),
    CONSTRAINT item_claims_item_fk FOREIGN KEY (item_id) REFERENCES lost_items (id) ON DELETE CASCADE,
    CONSTRAINT item_claims_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB;