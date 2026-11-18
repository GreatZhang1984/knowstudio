-- T-65：用户级素材源配置。Tavily API Key 只存 AES-256-GCM 密文；
-- 非敏感配置（Obsidian 地址/工具名/条数/超时）存 JSON，便于按用户动态装配适配器。
CREATE TABLE user_source_config (
  user_id               CHAR(36) COLLATE ascii_bin NOT NULL,
  source_id             ENUM('web_search','obsidian') NOT NULL,
  enabled               TINYINT(1) NOT NULL DEFAULT 1,
  settings              JSON NOT NULL,
  credential_ciphertext TEXT NULL,
  credential_last4      CHAR(4) COLLATE ascii_bin NULL,
  tested_at             DATETIME(3) NULL,
  created_at            DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                         ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, source_id),
  CONSTRAINT fk_source_config_user
    FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
