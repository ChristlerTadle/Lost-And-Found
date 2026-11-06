-- MySQL 8.0+ schema for the php_conversion MVP.
-- Run this file in XAMPP phpMyAdmin or the MySQL CLI.
-- Scope: registration, login, profile view/edit, and lost report create/view/edit.

CREATE DATABASE IF NOT EXISTS lost_and_found
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci;

USE lost_and_found;

CREATE TABLE IF NOT EXISTS roles (
    id SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
    role_name VARCHAR(20) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY roles_role_name_unique (role_name),
    CONSTRAINT roles_role_name_check CHECK (role_name IN ('user', 'staff', 'admin'))
) ENGINE = InnoDB;

INSERT IGNORE INTO roles (role_name)
VALUES ('user'), ('staff'), ('admin');

CREATE TABLE IF NOT EXISTS users (
    id CHAR(36) NOT NULL,
    role_id SMALLINT UNSIGNED NOT NULL,
    email VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(150) NOT NULL,
    student_id VARCHAR(50) NULL,
    employee_id VARCHAR(50) NULL,
    department VARCHAR(150) NULL,
    phone VARCHAR(30) NULL,
    status ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY users_email_unique (email),
    UNIQUE KEY users_student_id_unique (student_id),
    UNIQUE KEY users_employee_id_unique (employee_id),
    CONSTRAINT users_role_fk FOREIGN KEY (role_id) REFERENCES roles (id),
    CONSTRAINT users_identity_check CHECK (student_id IS NOT NULL OR employee_id IS NOT NULL)
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS lost_items (
    id CHAR(36) NOT NULL,
    user_id CHAR(36) NOT NULL,
    item_type ENUM('lost', 'found') NOT NULL DEFAULT 'lost',
    item_name VARCHAR(150) NOT NULL,
    description TEXT NOT NULL,
    identifying_details TEXT NOT NULL,
    category VARCHAR(100) NOT NULL,
    location VARCHAR(255) NOT NULL,
    date_lost DATE NOT NULL,
    image_path VARCHAR(255) NULL,
    status ENUM('lost', 'found', 'cancelled', 'claimed') NOT NULL DEFAULT 'lost',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY lost_items_user_id_idx (user_id),
    KEY lost_items_date_lost_idx (date_lost),
    CONSTRAINT lost_items_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB;

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

DROP PROCEDURE IF EXISTS get_profile;
DROP PROCEDURE IF EXISTS update_profile;
DROP PROCEDURE IF EXISTS list_my_lost_items;
DROP PROCEDURE IF EXISTS create_lost_item;
DROP PROCEDURE IF EXISTS update_lost_item;
DROP PROCEDURE IF EXISTS user_has_role;

DELIMITER $$

CREATE PROCEDURE get_profile(IN p_user_id CHAR(36))
BEGIN
    SELECT u.id, u.email, u.full_name, u.student_id, u.employee_id,
           u.department, u.phone, u.status, u.created_at, u.updated_at,
           r.id AS role_id, r.role_name
    FROM users AS u
    INNER JOIN roles AS r ON r.id = u.role_id
    WHERE u.id = p_user_id;
END$$

CREATE PROCEDURE update_profile(
    IN p_user_id CHAR(36),
    IN p_full_name VARCHAR(150),
    IN p_department VARCHAR(150),
    IN p_phone VARCHAR(30)
)
BEGIN
    UPDATE users
    SET full_name = TRIM(p_full_name),
        department = NULLIF(TRIM(p_department), ''),
        phone = NULLIF(TRIM(p_phone), '')
    WHERE id = p_user_id AND status = 'active';

    CALL get_profile(p_user_id);
END$$

CREATE PROCEDURE list_my_lost_items(IN p_user_id CHAR(36))
BEGIN
    SELECT id, user_id, item_name, description, identifying_details,
           category, location, date_lost, status, created_at, updated_at
    FROM lost_items
    WHERE user_id = p_user_id
    ORDER BY created_at DESC;
END$$

CREATE PROCEDURE create_lost_item(
    IN p_id CHAR(36),
    IN p_user_id CHAR(36),
    IN p_item_name VARCHAR(150),
    IN p_description TEXT,
    IN p_identifying_details TEXT,
    IN p_category VARCHAR(100),
    IN p_location VARCHAR(255),
    IN p_date_lost DATE
)
BEGIN
    INSERT INTO lost_items (
        id, user_id, item_name, description, identifying_details,
        category, location, date_lost
    ) VALUES (
        p_id, p_user_id, TRIM(p_item_name), TRIM(p_description),
        TRIM(p_identifying_details), TRIM(p_category), TRIM(p_location), p_date_lost
    );

    SELECT * FROM lost_items WHERE id = p_id;
END$$

CREATE PROCEDURE update_lost_item(
    IN p_id CHAR(36),
    IN p_user_id CHAR(36),
    IN p_item_name VARCHAR(150),
    IN p_description TEXT,
    IN p_identifying_details TEXT,
    IN p_category VARCHAR(100),
    IN p_location VARCHAR(255),
    IN p_date_lost DATE
)
BEGIN
    UPDATE lost_items
    SET item_name = TRIM(p_item_name),
        description = TRIM(p_description),
        identifying_details = TRIM(p_identifying_details),
        category = TRIM(p_category),
        location = TRIM(p_location),
        date_lost = p_date_lost
    WHERE id = p_id AND user_id = p_user_id AND status = 'lost';

    SELECT * FROM lost_items WHERE id = p_id AND user_id = p_user_id;
END$$

CREATE PROCEDURE user_has_role(IN p_user_id CHAR(36), IN p_role_name VARCHAR(20))
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM users AS u
        INNER JOIN roles AS r ON r.id = u.role_id
        WHERE u.id = p_user_id
          AND u.status = 'active'
          AND r.role_name = p_role_name
    ) AS has_role;
END$$

DELIMITER ;
