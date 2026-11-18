-- ===== app_user =====
CREATE TABLE `app_user` (
  `id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `name` varchar(120) NOT NULL,
  `avatar_url` varchar(1024) DEFAULT NULL,
  `phone` varchar(32) DEFAULT NULL,
  `email` varchar(255) DEFAULT NULL,
  `password_hash` varchar(255) DEFAULT NULL,
  `domain_prefs` json NOT NULL DEFAULT (json_array()),
  `default_platforms` json NOT NULL DEFAULT (cast(_utf8mb4'["douyin","sph","bili","xhs"]' as json)),
  `plan_id` varchar(40) NOT NULL DEFAULT 'creator_168',
  `theme` varchar(16) NOT NULL DEFAULT 'dark',
  `onboarded_at` datetime(3) DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_user_phone` (`phone`),
  UNIQUE KEY `uq_user_email` (`email`),
  CONSTRAINT `ck_user_contact` CHECK (((`phone` is not null) or (`email` is not null)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ===== style_sample =====
CREATE TABLE `style_sample` (
  `id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `user_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `title` varchar(255) NOT NULL,
  `content` mediumtext NOT NULL,
  `source` enum('upload','paste') NOT NULL,
  `status` enum('learning','ready','failed') NOT NULL DEFAULT 'learning',
  `char_count` int NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `ix_style_sample_user` (`user_id`,`created_at` DESC),
  CONSTRAINT `fk_sample_user` FOREIGN KEY (`user_id`) REFERENCES `app_user` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ===== style_profile =====
CREATE TABLE `style_profile` (
  `user_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `catchphrases` json NOT NULL DEFAULT (json_array()),
  `sentence_patterns` json NOT NULL DEFAULT (json_array()),
  `case_preferences` json NOT NULL DEFAULT (json_array()),
  `tone` varchar(255) DEFAULT NULL,
  `sample_count` int NOT NULL DEFAULT '0',
  `version` int NOT NULL DEFAULT '1',
  `is_default` tinyint(1) NOT NULL DEFAULT '1',
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`user_id`),
  CONSTRAINT `fk_profile_user` FOREIGN KEY (`user_id`) REFERENCES `app_user` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ===== user_source_config =====
CREATE TABLE `user_source_config` (
  `user_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `source_id` enum('web_search','obsidian') NOT NULL,
  `enabled` tinyint(1) NOT NULL DEFAULT '1',
  `settings` json NOT NULL,
  `credential_ciphertext` text,
  `credential_last4` char(4) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  `tested_at` datetime(3) DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`user_id`,`source_id`),
  CONSTRAINT `fk_source_config_user` FOREIGN KEY (`user_id`) REFERENCES `app_user` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ===== work =====
CREATE TABLE `work` (
  `id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `user_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `title` varchar(255) NOT NULL,
  `keyword` varchar(120) DEFAULT NULL,
  `phase` tinyint NOT NULL DEFAULT '0',
  `step` enum('search','topics','script','video.draft','video.rendering','video.rendered','derive','export','done') NOT NULL DEFAULT 'search',
  `selected_topic_id` char(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  `script_confirmed_at` datetime(3) DEFAULT NULL,
  `active_render_job_id` char(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  `gates` json NOT NULL DEFAULT (cast(_utf8mb4'{"G1":false,"G2":false,"G3":false,"G4":false}' as json)),
  `gates_fingerprint` char(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  `exported_at` datetime(3) DEFAULT NULL,
  `deleted_at` datetime(3) DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `ix_work_user_active` (`user_id`,`deleted_at`,`updated_at` DESC),
  KEY `ix_work_user_phase` (`user_id`,`phase`),
  FULLTEXT KEY `ft_work_title` (`title`) /*!50100 WITH PARSER `ngram` */ ,
  CONSTRAINT `fk_work_user` FOREIGN KEY (`user_id`) REFERENCES `app_user` (`id`) ON DELETE CASCADE,
  CONSTRAINT `ck_work_phase` CHECK ((`phase` between 0 and 4))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ===== material =====
CREATE TABLE `material` (
  `id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `user_id` char(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  `type` enum('knowledge','hot','peer','image','doc','music','font') NOT NULL,
  `title` varchar(500) NOT NULL,
  `source` varchar(120) NOT NULL,
  `source_url` varchar(1024) DEFAULT NULL,
  `source_color` varchar(16) DEFAULT NULL,
  `meta` json NOT NULL DEFAULT (json_object()),
  `body_text` mediumtext,
  `storage_key` varchar(512) DEFAULT NULL,
  `license` enum('cleared','restricted','unknown') NOT NULL DEFAULT 'unknown',
  `license_evidence` json DEFAULT NULL,
  `tags` json NOT NULL DEFAULT (json_array()),
  `fetched_at` datetime(3) DEFAULT NULL,
  `deleted_at` datetime(3) DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `ix_material_owner` (`user_id`,`deleted_at`,`type`,`created_at` DESC),
  KEY `ix_material_tags` ((cast(`tags` as char(64) array))),
  FULLTEXT KEY `ft_material_search` (`title`,`body_text`) /*!50100 WITH PARSER `ngram` */ ,
  CONSTRAINT `fk_material_user` FOREIGN KEY (`user_id`) REFERENCES `app_user` (`id`) ON DELETE CASCADE,
  CONSTRAINT `ck_material_evidence` CHECK (((`license` <> _utf8mb4'cleared') or (`license_evidence` is not null) or (`source` = _utf8mb4'self')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ===== work_material =====
CREATE TABLE `work_material` (
  `work_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `material_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `user_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `collected_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `used_in` json NOT NULL DEFAULT (json_array()),
  PRIMARY KEY (`work_id`,`material_id`),
  KEY `ix_wm_material` (`material_id`),
  KEY `ix_wm_used_target` ((cast(json_extract(`used_in`,_utf8mb4'$[*].target') as char(16) array))),
  CONSTRAINT `fk_wm_material` FOREIGN KEY (`material_id`) REFERENCES `material` (`id`),
  CONSTRAINT `fk_wm_work` FOREIGN KEY (`work_id`) REFERENCES `work` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ===== search_session =====
CREATE TABLE `search_session` (
  `id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `work_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `user_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `keyword` varchar(120) NOT NULL,
  `keyword_hash` char(32) CHARACTER SET ascii COLLATE ascii_bin GENERATED ALWAYS AS (md5(`keyword`)) STORED,
  `domain` varchar(60) DEFAULT NULL,
  `status` enum('queued','running','succeeded','failed','canceled') NOT NULL DEFAULT 'queued',
  `saturation` json DEFAULT NULL,
  `blank_angles` json NOT NULL DEFAULT (json_array()),
  `material_ids` json NOT NULL DEFAULT (json_array()),
  `partial_errors` json NOT NULL DEFAULT (json_array()),
  `duration_ms` int DEFAULT NULL,
  `cache_hit` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `ix_search_work` (`work_id`,`created_at` DESC),
  KEY `ix_search_cache` (`keyword_hash`,`created_at` DESC),
  CONSTRAINT `fk_search_work` FOREIGN KEY (`work_id`) REFERENCES `work` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ===== topic_batch =====
CREATE TABLE `topic_batch` (
  `id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `work_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `user_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `batch_index` int NOT NULL,
  `based_on_material_ids` json NOT NULL,
  `hook_fingerprints` json NOT NULL DEFAULT (json_array()),
  `min_pairwise_cosine` decimal(4,3) DEFAULT NULL,
  `regen_attempts` int NOT NULL DEFAULT '0',
  `effective_count` int NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_batch_index` (`work_id`,`batch_index`),
  CONSTRAINT `fk_batch_work` FOREIGN KEY (`work_id`) REFERENCES `work` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ===== topic =====
CREATE TABLE `topic` (
  `id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `batch_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `work_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `hook` varchar(500) NOT NULL,
  `angle` varchar(500) NOT NULL,
  `blank_point` varchar(500) NOT NULL,
  `basis_material_ids` json NOT NULL,
  `diversity_score` decimal(4,3) DEFAULT NULL,
  `embedding` json DEFAULT NULL,
  `hook_fingerprint` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `ord` int NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_topic_batch` (`batch_id`,`ord`),
  KEY `ix_topic_fp` (`work_id`,`hook_fingerprint`),
  CONSTRAINT `fk_topic_batch` FOREIGN KEY (`batch_id`) REFERENCES `topic_batch` (`id`) ON DELETE CASCADE,
  CONSTRAINT `ck_topic_basis` CHECK ((json_length(`basis_material_ids`) >= 1)),
  CONSTRAINT `ck_topic_emb_dim` CHECK (((`embedding` is null) or (json_length(`embedding`) = 1024)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ===== script =====
CREATE TABLE `script` (
  `id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `work_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `user_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `version` int NOT NULL DEFAULT '1',
  `status` enum('draft','confirmed','stale') NOT NULL DEFAULT 'draft',
  `confirmed_at` datetime(3) DEFAULT NULL,
  `estimated_duration` int DEFAULT NULL,
  `actual_duration` int DEFAULT NULL,
  `generated_text` mediumtext,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_script_work` (`work_id`),
  CONSTRAINT `fk_script_work` FOREIGN KEY (`work_id`) REFERENCES `work` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ===== script_section =====
CREATE TABLE `script_section` (
  `id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `script_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `kind` enum('hook3s','body','outro') NOT NULL,
  `ord` int NOT NULL,
  `range_start` smallint unsigned DEFAULT NULL,
  `range_end` smallint unsigned DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_section_kind` (`script_id`,`kind`),
  UNIQUE KEY `uq_section_ord` (`script_id`,`ord`),
  CONSTRAINT `fk_section_script` FOREIGN KEY (`script_id`) REFERENCES `script` (`id`) ON DELETE CASCADE,
  CONSTRAINT `ck_section_range` CHECK (((`range_start` is null) or (`range_end` is null) or (`range_start` < `range_end`)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ===== script_line =====
CREATE TABLE `script_line` (
  `id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `section_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `ord` int NOT NULL,
  `text` text NOT NULL,
  `edited_by_user` tinyint(1) NOT NULL DEFAULT '0',
  `char_count` int GENERATED ALWAYS AS (char_length(`text`)) STORED,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_line_ord` (`section_id`,`ord`),
  CONSTRAINT `fk_line_section` FOREIGN KEY (`section_id`) REFERENCES `script_section` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ===== script_revision =====
CREATE TABLE `script_revision` (
  `id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `script_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `version` int NOT NULL,
  `diff` json NOT NULL,
  `reason` enum('generate','edit','restyle','accept','reject','unlock') NOT NULL,
  `snapshot` json NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_rev_version` (`script_id`,`version`),
  KEY `ix_rev_script` (`script_id`,`version` DESC),
  CONSTRAINT `fk_rev_script` FOREIGN KEY (`script_id`) REFERENCES `script` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ===== style_hunk =====
CREATE TABLE `style_hunk` (
  `id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `script_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `line_id` char(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  `ord` int NOT NULL,
  `original` text NOT NULL,
  `rewritten` text NOT NULL,
  `status` enum('pending','accepted','rejected') NOT NULL DEFAULT 'pending',
  `resolved_at` datetime(3) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_hunk_script` (`script_id`,`status`,`ord`),
  KEY `fk_hunk_line` (`line_id`),
  CONSTRAINT `fk_hunk_line` FOREIGN KEY (`line_id`) REFERENCES `script_line` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_hunk_script` FOREIGN KEY (`script_id`) REFERENCES `script` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ===== script_variant =====
CREATE TABLE `script_variant` (
  `id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `script_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `platform_id` varchar(16) NOT NULL,
  `content` json NOT NULL,
  `duration` int DEFAULT NULL,
  `derived_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_variant_platform` (`script_id`,`platform_id`),
  CONSTRAINT `fk_variant_script` FOREIGN KEY (`script_id`) REFERENCES `script` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ===== asset_layer =====
CREATE TABLE `asset_layer` (
  `id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `work_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `user_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `kind` enum('audio','slides','subtitles','timeline','bgm','cover') NOT NULL,
  `version` int NOT NULL,
  `content_hash` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `storage_key` varchar(512) NOT NULL,
  `meta` json NOT NULL DEFAULT (json_object()),
  `input_fingerprint` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `duration_ms` int DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_layer_version` (`work_id`,`kind`,`version`),
  UNIQUE KEY `uq_layer_reuse` (`work_id`,`kind`,`input_fingerprint`),
  KEY `ix_layer_latest` (`work_id`,`kind`,`version` DESC),
  CONSTRAINT `fk_layer_work` FOREIGN KEY (`work_id`) REFERENCES `work` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ===== video_asset =====
CREATE TABLE `video_asset` (
  `id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `work_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `user_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `quality` enum('draft','hd','uhd4k') NOT NULL,
  `status` enum('queued','running','succeeded','failed','canceled') NOT NULL DEFAULT 'queued',
  `storage_key` varchar(512) DEFAULT NULL,
  `duration_ms` int DEFAULT NULL,
  `resolution` varchar(16) DEFAULT NULL,
  `orient` enum('vertical','horizontal') DEFAULT NULL,
  `template_id` varchar(40) DEFAULT NULL,
  `voice_id` varchar(40) DEFAULT NULL,
  `speed` decimal(3,2) NOT NULL DEFAULT '1.00',
  `script_version` int NOT NULL,
  `stale` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `ix_video_work` (`work_id`,`quality`,`created_at` DESC),
  CONSTRAINT `fk_video_work` FOREIGN KEY (`work_id`) REFERENCES `work` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ===== video_asset_layer =====
CREATE TABLE `video_asset_layer` (
  `video_asset_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `layer_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (`video_asset_id`,`layer_id`),
  KEY `ix_val_layer` (`layer_id`),
  CONSTRAINT `fk_val_layer` FOREIGN KEY (`layer_id`) REFERENCES `asset_layer` (`id`),
  CONSTRAINT `fk_val_video` FOREIGN KEY (`video_asset_id`) REFERENCES `video_asset` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ===== render_job =====
CREATE TABLE `render_job` (
  `id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `work_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `user_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `type` enum('draft','hd','patch','derive_media','export','search','topics','script','restyle') NOT NULL,
  `layer_scope` json NOT NULL DEFAULT (json_array()),
  `status` enum('queued','running','succeeded','failed','canceled') NOT NULL DEFAULT 'queued',
  `progress` tinyint NOT NULL DEFAULT '0',
  `stage` varchar(16) DEFAULT NULL,
  `cost_points` int NOT NULL DEFAULT '0',
  `reservation_id` char(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  `video_asset_id` char(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  `idempotency_key` varchar(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  `attempt` int NOT NULL DEFAULT '0',
  `error` json DEFAULT NULL,
  `cancel_requested` tinyint(1) NOT NULL DEFAULT '0',
  `started_at` datetime(3) DEFAULT NULL,
  `finished_at` datetime(3) DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `active_render_flag` tinyint GENERATED ALWAYS AS (if(((`status` in (_utf8mb4'queued',_utf8mb4'running')) and (`type` in (_utf8mb4'draft',_utf8mb4'hd',_utf8mb4'patch'))),1,NULL)) STORED,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_active_render_per_user` (`user_id`,`active_render_flag`),
  UNIQUE KEY `uq_render_idem` (`user_id`,`idempotency_key`),
  KEY `ix_job_work` (`work_id`,`created_at` DESC),
  KEY `fk_job_video` (`video_asset_id`),
  CONSTRAINT `fk_job_video` FOREIGN KEY (`video_asset_id`) REFERENCES `video_asset` (`id`),
  CONSTRAINT `fk_job_work` FOREIGN KEY (`work_id`) REFERENCES `work` (`id`) ON DELETE CASCADE,
  CONSTRAINT `ck_job_progress` CHECK ((`progress` between 0 and 100))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ===== render_job_event =====
CREATE TABLE `render_job_event` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `job_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seq` int NOT NULL,
  `event_type` varchar(16) NOT NULL,
  `payload` json NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_event_seq` (`job_id`,`seq`),
  CONSTRAINT `fk_event_job` FOREIGN KEY (`job_id`) REFERENCES `render_job` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ===== platform_rule =====
CREATE TABLE `platform_rule` (
  `platform_id` varchar(16) NOT NULL,
  `version` int NOT NULL,
  `name` varchar(60) NOT NULL,
  `ratio` varchar(8) NOT NULL,
  `max_duration` int NOT NULL,
  `orient` enum('vertical','horizontal') NOT NULL,
  `brand_color` varchar(16) NOT NULL,
  `style_hint` varchar(255) NOT NULL,
  `title_max` int NOT NULL,
  `title_hard_max` int NOT NULL,
  `tag_max` int NOT NULL,
  `banned_patterns` json NOT NULL DEFAULT (json_array()),
  `is_current` tinyint(1) NOT NULL DEFAULT '0',
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `current_flag` tinyint GENERATED ALWAYS AS (if(`is_current`,1,NULL)) STORED,
  PRIMARY KEY (`platform_id`,`version`),
  UNIQUE KEY `uq_rule_current` (`platform_id`,`current_flag`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ===== derivative =====
CREATE TABLE `derivative` (
  `id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `work_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `user_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `platform_id` varchar(16) NOT NULL,
  `title` varchar(255) NOT NULL DEFAULT '',
  `tags` json NOT NULL DEFAULT (json_array()),
  `duration_version` enum('full','essence30','teaser15') NOT NULL DEFAULT 'full',
  `cover_layer_id` char(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  `video_asset_id` char(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  `rule_version` int NOT NULL,
  `metadata_ready` tinyint(1) NOT NULL DEFAULT '0',
  `media_ready` tinyint(1) NOT NULL DEFAULT '0',
  `validation` json NOT NULL DEFAULT (json_array()),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_derivative_platform` (`work_id`,`platform_id`),
  KEY `fk_derivative_cover` (`cover_layer_id`),
  KEY `fk_derivative_video` (`video_asset_id`),
  KEY `ix_derivative_tags` ((cast(`tags` as char(64) array))),
  CONSTRAINT `fk_derivative_cover` FOREIGN KEY (`cover_layer_id`) REFERENCES `asset_layer` (`id`),
  CONSTRAINT `fk_derivative_video` FOREIGN KEY (`video_asset_id`) REFERENCES `video_asset` (`id`),
  CONSTRAINT `fk_derivative_work` FOREIGN KEY (`work_id`) REFERENCES `work` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ===== compliance_report =====
CREATE TABLE `compliance_report` (
  `id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `work_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `user_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `items` json NOT NULL,
  `blocking_count` int NOT NULL,
  `warn_count` int NOT NULL DEFAULT '0',
  `fingerprint` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `checked_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_compliance_fp` (`work_id`,`fingerprint`),
  KEY `ix_compliance_work` (`work_id`,`checked_at` DESC),
  CONSTRAINT `fk_report_work` FOREIGN KEY (`work_id`) REFERENCES `work` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ===== export_package =====
CREATE TABLE `export_package` (
  `id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `work_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `user_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `status` enum('queued','running','succeeded','failed','canceled') NOT NULL DEFAULT 'queued',
  `files` json NOT NULL DEFAULT (json_array()),
  `manifest_key` varchar(512) DEFAULT NULL,
  `checklist_key` varchar(512) DEFAULT NULL,
  `package_key` varchar(512) DEFAULT NULL,
  `package_size` bigint DEFAULT NULL,
  `report_id` char(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  `expires_at` datetime(3) NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `ix_export_work` (`work_id`,`created_at` DESC),
  KEY `fk_export_report` (`report_id`),
  CONSTRAINT `fk_export_report` FOREIGN KEY (`report_id`) REFERENCES `compliance_report` (`id`),
  CONSTRAINT `fk_export_work` FOREIGN KEY (`work_id`) REFERENCES `work` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ===== quota_account =====
CREATE TABLE `quota_account` (
  `user_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `plan_id` varchar(40) NOT NULL,
  `total` int NOT NULL,
  `used` int NOT NULL DEFAULT '0',
  `reserved` int NOT NULL DEFAULT '0',
  `reset_at` datetime(3) NOT NULL,
  `version` bigint NOT NULL DEFAULT '0',
  PRIMARY KEY (`user_id`),
  CONSTRAINT `fk_quota_user` FOREIGN KEY (`user_id`) REFERENCES `app_user` (`id`) ON DELETE CASCADE,
  CONSTRAINT `ck_quota_no_overdraft` CHECK (((`used` + `reserved`) <= `total`)),
  CONSTRAINT `ck_quota_reserved` CHECK ((`reserved` >= 0)),
  CONSTRAINT `ck_quota_total` CHECK ((`total` >= 0)),
  CONSTRAINT `ck_quota_used` CHECK ((`used` >= 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ===== quota_reservation =====
CREATE TABLE `quota_reservation` (
  `id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `user_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `work_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `job_id` char(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  `points` int NOT NULL,
  `state` enum('held','committed','released','expired') NOT NULL DEFAULT 'held',
  `expires_at` datetime(3) NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `settled_at` datetime(3) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_rsv_held` (`state`,`expires_at`),
  KEY `fk_rsv_user` (`user_id`),
  CONSTRAINT `fk_rsv_user` FOREIGN KEY (`user_id`) REFERENCES `app_user` (`id`) ON DELETE CASCADE,
  CONSTRAINT `ck_rsv_points` CHECK ((`points` > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ===== quota_ledger =====
CREATE TABLE `quota_ledger` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `user_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `work_id` char(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  `job_id` char(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  `reservation_id` char(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  `action` enum('grant','reserve','commit','release','reset','adjust') NOT NULL,
  `points` int NOT NULL,
  `balance_after` int NOT NULL,
  `idempotency_key` varchar(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  `note` varchar(255) DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_ledger_idem` (`user_id`,`idempotency_key`),
  KEY `ix_ledger_user_month` (`user_id`,`created_at` DESC),
  KEY `fk_ledger_rsv` (`reservation_id`),
  CONSTRAINT `fk_ledger_rsv` FOREIGN KEY (`reservation_id`) REFERENCES `quota_reservation` (`id`),
  CONSTRAINT `fk_ledger_user` FOREIGN KEY (`user_id`) REFERENCES `app_user` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ===== trend =====
CREATE TABLE `trend` (
  `id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `domain` varchar(60) NOT NULL,
  `name` varchar(255) NOT NULL,
  `heat` decimal(10,2) DEFAULT NULL,
  `lifecycle` enum('rising','peaked','faded') NOT NULL,
  `window_hours` int DEFAULT NULL,
  `angles` json NOT NULL DEFAULT (json_array()),
  `source` varchar(120) NOT NULL,
  `fetched_at` datetime(3) NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `ix_trend_domain` (`domain`,`lifecycle`,`fetched_at` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ===== job_queue =====
CREATE TABLE `job_queue` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `queue` varchar(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `job_id` char(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  `user_id` char(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  `payload` json NOT NULL DEFAULT (json_object()),
  `state` enum('pending','leased','done','dead','canceled') NOT NULL DEFAULT 'pending',
  `run_after` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `attempt` int NOT NULL DEFAULT '0',
  `max_attempt` int NOT NULL DEFAULT '3',
  `lease_owner` varchar(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  `lease_expires_at` datetime(3) DEFAULT NULL,
  `lease_token` bigint unsigned NOT NULL DEFAULT '0',
  `dedup_key` varchar(128) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  `last_error` json DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `started_at` datetime(3) DEFAULT NULL,
  `finished_at` datetime(3) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_queue_dedup` (`queue`,`dedup_key`),
  KEY `ix_queue_pick` (`queue`,`state`,`run_after`,`id`),
  KEY `ix_queue_lease` (`state`,`lease_expires_at`),
  KEY `ix_queue_job` (`job_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ===== metric_snapshot =====
CREATE TABLE `metric_snapshot` (
  `metric` varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `scope` varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'global',
  `scope_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '-',
  `bucket` datetime(3) NOT NULL,
  `value_num` decimal(18,4) NOT NULL,
  `sample_n` int NOT NULL DEFAULT '0',
  `computed_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`metric`,`scope`,`scope_id`,`bucket`),
  KEY `ix_metric_bucket` (`metric`,`bucket`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ===== idempotency_record =====
CREATE TABLE `idempotency_record` (
  `user_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `key` varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `request_hash` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `status_code` int DEFAULT NULL,
  `response` json DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`user_id`,`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ===== analytics_event =====
CREATE TABLE `analytics_event` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `user_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `work_id` char(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  `event` varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `props` json NOT NULL DEFAULT (json_object()),
  `occurred_at` datetime(3) NOT NULL,
  `ingested_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `ix_event_work` (`work_id`,`event`,`occurred_at`),
  KEY `ix_event_time` (`event`,`occurred_at` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ===== ai_call_log =====
CREATE TABLE `ai_call_log` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `user_id` char(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  `work_id` char(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  `job_id` char(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  `port` varchar(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `provider` varchar(40) NOT NULL,
  `model` varchar(60) NOT NULL,
  `input_tokens` int DEFAULT NULL,
  `output_tokens` int DEFAULT NULL,
  `audio_chars` int DEFAULT NULL,
  `cost_cny` decimal(10,4) DEFAULT NULL,
  `latency_ms` int DEFAULT NULL,
  `cache_hit` tinyint(1) NOT NULL DEFAULT '0',
  `fallback_from` varchar(40) DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `ix_aicall_work` (`work_id`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ===== audit_log =====
CREATE TABLE `audit_log` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `user_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `work_id` char(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  `action` varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `target` varchar(120) DEFAULT NULL,
  `payload` json DEFAULT NULL,
  `ip` varchar(45) DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `ix_audit_user` (`user_id`,`created_at` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ===== voice_catalog =====
CREATE TABLE `voice_catalog` (
  `id` varchar(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `provider` varchar(40) NOT NULL,
  `name` varchar(60) NOT NULL,
  `gender` varchar(16) DEFAULT NULL,
  `timbre` varchar(40) DEFAULT NULL,
  `sample_layer_key` varchar(512) NOT NULL,
  `license_evidence` json NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `ord` int DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ===== template_catalog =====
CREATE TABLE `template_catalog` (
  `id` varchar(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `name` varchar(60) NOT NULL,
  `version` int NOT NULL,
  `palette` json NOT NULL,
  `font_family` varchar(120) NOT NULL,
  `page_types` json NOT NULL,
  `orients` json NOT NULL DEFAULT (cast(_utf8mb4'["vertical","horizontal"]' as json)),
  `manifest_key` varchar(512) NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
