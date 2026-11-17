-- ============================================================================
-- KnowStudio 基线 DDL · MySQL 8.4 LTS（硬性下限 8.0.17）
-- 前置：SET NAMES utf8mb4; 连接 time_zone='+00:00';
--       sql_mode 含 STRICT_TRANS_TABLES; 实例 ngram_token_size=2（只读，需重启）
-- 约定：ID 列写作 CHAR(36) COLLATE ascii_bin —— 只写 COLLATE 时 MySQL 由
--       collation 名推导出 CHARACTER SET ascii，等价于显式写 CHARACTER SET ascii。
--       所有 FK 两端列的 charset/collation 必须一致（否则 errno 3780）。
-- ============================================================================

-- ① 用户与风格 -------------------------------------------------------------
CREATE TABLE app_user (
  id              CHAR(36) COLLATE ascii_bin NOT NULL,
  name            VARCHAR(120)  NOT NULL,
  avatar_url      VARCHAR(1024) NULL,
  phone           VARCHAR(32)   NULL,
  email           VARCHAR(255)  NULL,
  password_hash   VARCHAR(255)  NULL,
  domain_prefs    JSON NOT NULL DEFAULT (JSON_ARRAY()),
  default_platforms JSON NOT NULL
      DEFAULT (CAST('["douyin","sph","bili","xhs"]' AS JSON)),
  plan_id         VARCHAR(40)   NOT NULL DEFAULT 'creator_168',
  theme           VARCHAR(16)   NOT NULL DEFAULT 'dark',
  onboarded_at    DATETIME(3) NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_phone (phone),
  UNIQUE KEY uq_user_email (email),
  CONSTRAINT ck_user_contact CHECK (phone IS NOT NULL OR email IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE style_sample (
  id          CHAR(36) COLLATE ascii_bin NOT NULL,
  user_id     CHAR(36) COLLATE ascii_bin NOT NULL,
  title       VARCHAR(255) NOT NULL,
  content     MEDIUMTEXT   NOT NULL,
  source      ENUM('upload','paste') NOT NULL,
  status      ENUM('learning','ready','failed') NOT NULL DEFAULT 'learning',
  char_count  INT NOT NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_style_sample_user (user_id, created_at DESC),
  CONSTRAINT fk_sample_user FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE style_profile (
  user_id           CHAR(36) COLLATE ascii_bin NOT NULL,
  catchphrases      JSON NOT NULL DEFAULT (JSON_ARRAY()),
  sentence_patterns JSON NOT NULL DEFAULT (JSON_ARRAY()),
  case_preferences  JSON NOT NULL DEFAULT (JSON_ARRAY()),
  tone              VARCHAR(255) NULL,
  sample_count      INT NOT NULL DEFAULT 0,
  version           INT NOT NULL DEFAULT 1,
  is_default        TINYINT(1) NOT NULL DEFAULT 1,   -- SPEC §3.4 冷启动兜底
  updated_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id),
  CONSTRAINT fk_profile_user FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ② Work 核心上下文 --------------------------------------------------------
CREATE TABLE work (
  id                   CHAR(36) COLLATE ascii_bin NOT NULL,
  user_id              CHAR(36) COLLATE ascii_bin NOT NULL,
  title                VARCHAR(255) NOT NULL,
  keyword              VARCHAR(120) NULL,
  phase                TINYINT NOT NULL DEFAULT 0,
  step                 ENUM('search','topics','script','video.draft','video.rendering',
                            'video.rendered','derive','export','done')
                       NOT NULL DEFAULT 'search',
  selected_topic_id    CHAR(36) COLLATE ascii_bin NULL,   -- G1 真相
  script_confirmed_at  DATETIME(3) NULL,                  -- G2 真相
  active_render_job_id CHAR(36) COLLATE ascii_bin NULL,
  gates                JSON NOT NULL
      DEFAULT (CAST('{"G1":false,"G2":false,"G3":false,"G4":false}' AS JSON)),
  gates_fingerprint    CHAR(64) COLLATE ascii_bin NULL,   -- 闸门缓存指纹，见 §5.2
  exported_at          DATETIME(3) NULL,
  deleted_at           DATETIME(3) NULL,
  created_at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                       ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- MySQL 无部分索引：把 deleted_at 折进索引前缀（IS NULL 走 ref 访问，仍可有序扫 updated_at）
  KEY ix_work_user_active (user_id, deleted_at, updated_at DESC),
  KEY ix_work_user_phase  (user_id, phase),
  FULLTEXT KEY ft_work_title (title) WITH PARSER ngram,   -- GET /works?q=
  CONSTRAINT ck_work_phase CHECK (phase BETWEEN 0 AND 4),
  CONSTRAINT fk_work_user FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
-- progress 不入库：由 domain.progressOf(step) 确定性计算（消灭 D-02）

-- ③ 素材与引用 -------------------------------------------------------------
CREATE TABLE material (
  id               CHAR(36) COLLATE ascii_bin NOT NULL,
  user_id          CHAR(36) COLLATE ascii_bin NULL,   -- NULL = 全局公共库
  type             ENUM('knowledge','hot','peer','image','doc','music','font') NOT NULL,
  title            VARCHAR(500) NOT NULL,
  source           VARCHAR(120) NOT NULL,
  source_url       VARCHAR(1024) NULL,
  source_color     VARCHAR(16)  NULL,
  meta             JSON NOT NULL DEFAULT (JSON_OBJECT()),  -- 热度/赞同/播放量等
  body_text        MEDIUMTEXT NULL,                        -- 供搬运检测 LCS 比对
  storage_key      VARCHAR(512) NULL,
  license          ENUM('cleared','restricted','unknown') NOT NULL DEFAULT 'unknown',
  license_evidence JSON NULL,                              -- {type,url,expiresAt,uploadedAt}
  tags             JSON NOT NULL DEFAULT (JSON_ARRAY()),
  fetched_at       DATETIME(3) NULL,
  deleted_at       DATETIME(3) NULL,
  created_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_material_owner (user_id, deleted_at, type, created_at DESC),
  -- 多值索引（8.0.17+）：供 'x' MEMBER OF(tags) / JSON_CONTAINS / JSON_OVERLAPS
  KEY ix_material_tags ((CAST(tags AS CHAR(64) ARRAY))),
  -- 中文全文检索：ngram 双字切分，ngram_token_size 为实例级只读参数
  FULLTEXT KEY ft_material_search (title, body_text) WITH PARSER ngram,
  CONSTRAINT ck_material_evidence
      CHECK (license <> 'cleared' OR license_evidence IS NOT NULL OR source = 'self'),
  CONSTRAINT fk_material_user FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE work_material (
  work_id      CHAR(36) COLLATE ascii_bin NOT NULL,
  material_id  CHAR(36) COLLATE ascii_bin NOT NULL,
  user_id      CHAR(36) COLLATE ascii_bin NOT NULL,   -- 冗余，用于隔离校验与合规批量查询
  collected_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  used_in      JSON NOT NULL DEFAULT (JSON_ARRAY()),
      -- [{target:'slides',pageId:'p2'},{target:'script',lineId:'l3'}]
  PRIMARY KEY (work_id, material_id),
  KEY ix_wm_used_target ((CAST(used_in->'$[*].target' AS CHAR(16) ARRAY))),
  KEY ix_wm_material (material_id),                   -- 反查「被引用作品」§3.9
  CONSTRAINT fk_wm_work FOREIGN KEY (work_id) REFERENCES work(id) ON DELETE CASCADE,
  CONSTRAINT fk_wm_material FOREIGN KEY (material_id) REFERENCES material(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ④ 搜索与选题 -------------------------------------------------------------
CREATE TABLE search_session (
  id             CHAR(36) COLLATE ascii_bin NOT NULL,
  work_id        CHAR(36) COLLATE ascii_bin NOT NULL,
  user_id        CHAR(36) COLLATE ascii_bin NOT NULL,
  keyword        VARCHAR(120) NOT NULL,
  keyword_hash   CHAR(32) COLLATE ascii_bin AS (MD5(keyword)) STORED,
  domain         VARCHAR(60) NULL,
  status         ENUM('queued','running','succeeded','failed','canceled')
                 NOT NULL DEFAULT 'queued',
  saturation     JSON NULL,  -- {score,level,confidence,sampleSize,coveredPlatforms[],sources[]}
  blank_angles   JSON NOT NULL DEFAULT (JSON_ARRAY()),
  material_ids   JSON NOT NULL DEFAULT (JSON_ARRAY()),
  partial_errors JSON NOT NULL DEFAULT (JSON_ARRAY()),   -- 单源失败明细（partial 态）
  duration_ms    INT NULL,
  cache_hit      TINYINT(1) NOT NULL DEFAULT 0,
  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_search_work  (work_id, created_at DESC),
  KEY ix_search_cache (keyword_hash, created_at DESC),
  CONSTRAINT fk_search_work FOREIGN KEY (work_id) REFERENCES work(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE topic_batch (
  id                    CHAR(36) COLLATE ascii_bin NOT NULL,
  work_id               CHAR(36) COLLATE ascii_bin NOT NULL,
  user_id               CHAR(36) COLLATE ascii_bin NOT NULL,
  batch_index           INT NOT NULL,
  based_on_material_ids JSON NOT NULL,
  hook_fingerprints     JSON NOT NULL DEFAULT (JSON_ARRAY()),  -- 跨批去重依据（D-09）
  min_pairwise_cosine   DECIMAL(4,3) NULL,
  regen_attempts        INT NOT NULL DEFAULT 0,                -- 上限 2，SPEC §6.2
  effective_count       INT NOT NULL,                          -- 差异不足时明示有效数量
  created_at            DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_batch_index (work_id, batch_index),
  CONSTRAINT fk_batch_work FOREIGN KEY (work_id) REFERENCES work(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE topic (
  id                 CHAR(36) COLLATE ascii_bin NOT NULL,
  batch_id           CHAR(36) COLLATE ascii_bin NOT NULL,
  work_id            CHAR(36) COLLATE ascii_bin NOT NULL,
  hook               VARCHAR(500) NOT NULL,
  angle              VARCHAR(500) NOT NULL,
  blank_point        VARCHAR(500) NOT NULL,
  basis_material_ids JSON NOT NULL,
  diversity_score    DECIMAL(4,3) NULL,
  -- MySQL 8 无 VECTOR 类型（9.0 才有）：JSON 存 1024 维 float，cosine 在应用层算
  embedding          JSON NULL,
  hook_fingerprint   CHAR(64) COLLATE ascii_bin NOT NULL,
  ord                INT NOT NULL,
  PRIMARY KEY (id),
  KEY ix_topic_batch (batch_id, ord),
  KEY ix_topic_fp    (work_id, hook_fingerprint),
  CONSTRAINT ck_topic_basis CHECK (JSON_LENGTH(basis_material_ids) >= 1),
  CONSTRAINT ck_topic_emb_dim CHECK (embedding IS NULL OR JSON_LENGTH(embedding) = 1024),
  CONSTRAINT fk_topic_batch FOREIGN KEY (batch_id) REFERENCES topic_batch(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ⑤ 文案 -------------------------------------------------------------------
CREATE TABLE script (
  id                 CHAR(36) COLLATE ascii_bin NOT NULL,
  work_id            CHAR(36) COLLATE ascii_bin NOT NULL,
  user_id            CHAR(36) COLLATE ascii_bin NOT NULL,
  version            INT NOT NULL DEFAULT 1,
  status             ENUM('draft','confirmed','stale') NOT NULL DEFAULT 'draft',
  confirmed_at       DATETIME(3) NULL,
  estimated_duration INT NULL,   -- round(字数/4.2)，仅编辑期提示
  actual_duration    INT NULL,   -- TTS 对齐后真值，唯一权威（D-10）
  generated_text     MEDIUMTEXT NULL,   -- 大改率基线，SPEC §11
  created_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                     ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_script_work (work_id),
  CONSTRAINT fk_script_work FOREIGN KEY (work_id) REFERENCES work(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE script_section (
  id          CHAR(36) COLLATE ascii_bin NOT NULL,
  script_id   CHAR(36) COLLATE ascii_bin NOT NULL,
  kind        ENUM('hook3s','body','outro') NOT NULL,
  ord         INT NOT NULL,
  range_start SMALLINT UNSIGNED NULL,   -- 原 int4range [start,end) 拆两列
  range_end   SMALLINT UNSIGNED NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_section_kind (script_id, kind),
  UNIQUE KEY uq_section_ord  (script_id, ord),
  CONSTRAINT ck_section_range CHECK (range_start IS NULL OR range_end IS NULL
                                     OR range_start < range_end),
  CONSTRAINT fk_section_script FOREIGN KEY (script_id) REFERENCES script(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE script_line (
  id             CHAR(36) COLLATE ascii_bin NOT NULL,
  section_id     CHAR(36) COLLATE ascii_bin NOT NULL,
  ord            INT NOT NULL,
  `text`         TEXT NOT NULL,           -- TEXT 是类型关键字，统一反引号
  edited_by_user TINYINT(1) NOT NULL DEFAULT 0,
  char_count     INT AS (CHAR_LENGTH(`text`)) STORED,   -- D-11 字数不含提示装饰层
  PRIMARY KEY (id),
  UNIQUE KEY uq_line_ord (section_id, ord),
  CONSTRAINT fk_line_section FOREIGN KEY (section_id)
      REFERENCES script_section(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE script_revision (
  id          CHAR(36) COLLATE ascii_bin NOT NULL,
  script_id   CHAR(36) COLLATE ascii_bin NOT NULL,
  version     INT NOT NULL,
  diff        JSON NOT NULL,   -- [{lineId,before,after}]
  reason      ENUM('generate','edit','restyle','accept','reject','unlock') NOT NULL,
  snapshot    JSON NOT NULL,   -- 全量快照，支撑 ≥20 步撤销与冲突双版本
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_rev_version (script_id, version),
  KEY ix_rev_script (script_id, version DESC),
  CONSTRAINT fk_rev_script FOREIGN KEY (script_id) REFERENCES script(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE style_hunk (
  id          CHAR(36) COLLATE ascii_bin NOT NULL,
  script_id   CHAR(36) COLLATE ascii_bin NOT NULL,
  line_id     CHAR(36) COLLATE ascii_bin NULL,
  ord         INT NOT NULL,
  original    TEXT NOT NULL,
  rewritten   TEXT NOT NULL,
  status      ENUM('pending','accepted','rejected') NOT NULL DEFAULT 'pending',
  resolved_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY ix_hunk_script (script_id, status, ord),
  CONSTRAINT fk_hunk_script FOREIGN KEY (script_id) REFERENCES script(id) ON DELETE CASCADE,
  CONSTRAINT fk_hunk_line FOREIGN KEY (line_id) REFERENCES script_line(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE script_variant (
  id          CHAR(36) COLLATE ascii_bin NOT NULL,
  script_id   CHAR(36) COLLATE ascii_bin NOT NULL,
  platform_id VARCHAR(16) NOT NULL,
  content     JSON NOT NULL,
  duration    INT NULL,
  derived_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_variant_platform (script_id, platform_id),   -- P1 Story 11
  CONSTRAINT fk_variant_script FOREIGN KEY (script_id) REFERENCES script(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ⑥ 分层资产与视频 ---------------------------------------------------------
CREATE TABLE asset_layer (
  id                CHAR(36) COLLATE ascii_bin NOT NULL,
  work_id           CHAR(36) COLLATE ascii_bin NOT NULL,
  user_id           CHAR(36) COLLATE ascii_bin NOT NULL,
  kind              ENUM('audio','slides','subtitles','timeline','bgm','cover') NOT NULL,
  version           INT NOT NULL,
  content_hash      CHAR(64) COLLATE ascii_bin NOT NULL,   -- 内容寻址：命中即复用
  storage_key       VARCHAR(512) NOT NULL,
  meta              JSON NOT NULL DEFAULT (JSON_OBJECT()),
      -- audio:{voiceId,speed,segments[]} slides:{templateId,pages[]}
  input_fingerprint CHAR(64) COLLATE ascii_bin NOT NULL,   -- 决定该层内容的全部输入之哈希
  duration_ms       INT NULL,
  created_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_layer_version (work_id, kind, version),
  UNIQUE KEY uq_layer_reuse   (work_id, kind, input_fingerprint),
  KEY ix_layer_latest (work_id, kind, version DESC),
  CONSTRAINT fk_layer_work FOREIGN KEY (work_id) REFERENCES work(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE video_asset (
  id             CHAR(36) COLLATE ascii_bin NOT NULL,
  work_id        CHAR(36) COLLATE ascii_bin NOT NULL,
  user_id        CHAR(36) COLLATE ascii_bin NOT NULL,
  quality        ENUM('draft','hd','uhd4k') NOT NULL,
  status         ENUM('queued','running','succeeded','failed','canceled')
                 NOT NULL DEFAULT 'queued',
  storage_key    VARCHAR(512) NULL,
  duration_ms    INT NULL,
  resolution     VARCHAR(16) NULL,        -- 854x480 / 1920x1080 / 3840x2160
  orient         ENUM('vertical','horizontal') NULL,
  template_id    VARCHAR(40) NULL,
  voice_id       VARCHAR(40) NULL,
  speed          DECIMAL(3,2) NOT NULL DEFAULT 1.00,
  script_version INT NOT NULL,
  stale          TINYINT(1) NOT NULL DEFAULT 0,   -- 母版变更后置 1（SPEC §3.4）
  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_video_work (work_id, quality, created_at DESC),
  CONSTRAINT fk_video_work FOREIGN KEY (work_id) REFERENCES work(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE video_asset_layer (
  video_asset_id CHAR(36) COLLATE ascii_bin NOT NULL,
  layer_id       CHAR(36) COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (video_asset_id, layer_id),
  KEY ix_val_layer (layer_id),
  CONSTRAINT fk_val_video FOREIGN KEY (video_asset_id)
      REFERENCES video_asset(id) ON DELETE CASCADE,
  CONSTRAINT fk_val_layer FOREIGN KEY (layer_id) REFERENCES asset_layer(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ⑦ 渲染任务 ---------------------------------------------------------------
CREATE TABLE render_job (
  id              CHAR(36) COLLATE ascii_bin NOT NULL,
  work_id         CHAR(36) COLLATE ascii_bin NOT NULL,
  user_id         CHAR(36) COLLATE ascii_bin NOT NULL,
  type            ENUM('draft','hd','patch','derive_media','export','search','topics',
                       'script','restyle') NOT NULL,
  layer_scope     JSON NOT NULL DEFAULT (JSON_ARRAY()),
  status          ENUM('queued','running','succeeded','failed','canceled')
                  NOT NULL DEFAULT 'queued',
  progress        TINYINT NOT NULL DEFAULT 0,
  stage           VARCHAR(16) NULL,       -- queued|tts|slides|align|mux|finalize
  cost_points     INT NOT NULL DEFAULT 0,
  reservation_id  CHAR(36) COLLATE ascii_bin NULL,
  video_asset_id  CHAR(36) COLLATE ascii_bin NULL,
  idempotency_key VARCHAR(64) COLLATE ascii_bin NULL,
  attempt         INT NOT NULL DEFAULT 0,
  error           JSON NULL,
  cancel_requested TINYINT(1) NOT NULL DEFAULT 0,
  started_at      DATETIME(3) NULL,
  finished_at     DATETIME(3) NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- ★并发上限 1/用户：MySQL 无部分唯一索引 → STORED 生成列把谓词编码为 1/NULL，
  --   利用「唯一索引中 NULL 互不相等」实现条件唯一。仍是 DB 唯一性保证，非 SELECT-then-INSERT。
  active_render_flag TINYINT
      AS (IF(status IN ('queued','running') AND type IN ('draft','hd','patch'), 1, NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uq_active_render_per_user (user_id, active_render_flag),
  -- NULL 幂等键天然互不相等，无需生成列（等价于 PG 的 WHERE idempotency_key IS NOT NULL）
  UNIQUE KEY uq_render_idem (user_id, idempotency_key),
  KEY ix_job_work (work_id, created_at DESC),
  CONSTRAINT ck_job_progress CHECK (progress BETWEEN 0 AND 100),
  CONSTRAINT fk_job_work FOREIGN KEY (work_id) REFERENCES work(id) ON DELETE CASCADE,
  CONSTRAINT fk_job_video FOREIGN KEY (video_asset_id) REFERENCES video_asset(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE render_job_event (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  job_id     CHAR(36) COLLATE ascii_bin NOT NULL,
  seq        INT NOT NULL,
  event_type VARCHAR(16) NOT NULL,        -- progress|stage|status|quota|done|error
  payload    JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_event_seq (job_id, seq),  -- SSE Last-Event-ID 回放依据
  CONSTRAINT fk_event_job FOREIGN KEY (job_id) REFERENCES render_job(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ⑧ 平台规则与派生 ---------------------------------------------------------
CREATE TABLE platform_rule (
  platform_id     VARCHAR(16) NOT NULL,
  version         INT NOT NULL,
  name            VARCHAR(60) NOT NULL,
  ratio           VARCHAR(8)  NOT NULL,   -- '9:16' | '16:9'
  max_duration    INT NOT NULL,
  orient          ENUM('vertical','horizontal') NOT NULL,
  brand_color     VARCHAR(16) NOT NULL,
  style_hint      VARCHAR(255) NOT NULL,
  title_max       INT NOT NULL,           -- 建议字数（超 → warn）
  title_hard_max  INT NOT NULL,           -- 硬上限（超 → block）[推断]
  tag_max         INT NOT NULL,
  banned_patterns JSON NOT NULL DEFAULT (JSON_ARRAY()),
  is_current      TINYINT(1) NOT NULL DEFAULT 0,
  updated_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                  ON UPDATE CURRENT_TIMESTAMP(3),
  current_flag    TINYINT AS (IF(is_current, 1, NULL)) STORED,
  PRIMARY KEY (platform_id, version),
  UNIQUE KEY uq_rule_current (platform_id, current_flag)   -- 每平台恰好一个当前版本
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE derivative (
  id               CHAR(36) COLLATE ascii_bin NOT NULL,
  work_id          CHAR(36) COLLATE ascii_bin NOT NULL,
  user_id          CHAR(36) COLLATE ascii_bin NOT NULL,
  platform_id      VARCHAR(16) NOT NULL,
  title            VARCHAR(255) NOT NULL DEFAULT '',
  tags             JSON NOT NULL DEFAULT (JSON_ARRAY()),
  duration_version ENUM('full','essence30','teaser15') NOT NULL DEFAULT 'full',
  cover_layer_id   CHAR(36) COLLATE ascii_bin NULL,
  video_asset_id   CHAR(36) COLLATE ascii_bin NULL,
  rule_version     INT NOT NULL,
  metadata_ready   TINYINT(1) NOT NULL DEFAULT 0,   -- D-07：渲染前即可 1
  media_ready      TINYINT(1) NOT NULL DEFAULT 0,   -- G3 后才可能 1
  validation       JSON NOT NULL DEFAULT (JSON_ARRAY()),
  updated_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                   ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_derivative_platform (work_id, platform_id),   -- 各平台独立存储（AC-P4）
  KEY ix_derivative_tags ((CAST(tags AS CHAR(64) ARRAY))),
  CONSTRAINT fk_derivative_work FOREIGN KEY (work_id) REFERENCES work(id) ON DELETE CASCADE,
  CONSTRAINT fk_derivative_cover FOREIGN KEY (cover_layer_id) REFERENCES asset_layer(id),
  CONSTRAINT fk_derivative_video FOREIGN KEY (video_asset_id) REFERENCES video_asset(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ⑨ 合规与导出 -------------------------------------------------------------
CREATE TABLE compliance_report (
  id             CHAR(36) COLLATE ascii_bin NOT NULL,
  work_id        CHAR(36) COLLATE ascii_bin NOT NULL,
  user_id        CHAR(36) COLLATE ascii_bin NOT NULL,
  items          JSON NOT NULL,  -- [{kind,status,detail,blocking,materialIds[],fixHint}]
  blocking_count INT NOT NULL,
  warn_count     INT NOT NULL DEFAULT 0,
  fingerprint    CHAR(64) COLLATE ascii_bin NOT NULL,   -- G4 防陈旧放行，见 §8.4
  checked_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_compliance_work (work_id, checked_at DESC),
  UNIQUE KEY uq_compliance_fp (work_id, fingerprint),
  CONSTRAINT fk_report_work FOREIGN KEY (work_id) REFERENCES work(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE export_package (
  id            CHAR(36) COLLATE ascii_bin NOT NULL,
  work_id       CHAR(36) COLLATE ascii_bin NOT NULL,
  user_id       CHAR(36) COLLATE ascii_bin NOT NULL,
  status        ENUM('queued','running','succeeded','failed','canceled')
                NOT NULL DEFAULT 'queued',
  files         JSON NOT NULL DEFAULT (JSON_ARRAY()),
  manifest_key  VARCHAR(512) NULL,
  checklist_key VARCHAR(512) NULL,        -- 发布清单.md
  package_key   VARCHAR(512) NULL,
  package_size  BIGINT NULL,
  report_id     CHAR(36) COLLATE ascii_bin NULL,
  expires_at    DATETIME(3) NOT NULL,     -- 签名 24h；产物保留 ≥7 天
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_export_work (work_id, created_at DESC),
  CONSTRAINT fk_export_work FOREIGN KEY (work_id) REFERENCES work(id) ON DELETE CASCADE,
  CONSTRAINT fk_export_report FOREIGN KEY (report_id) REFERENCES compliance_report(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ⑩ 配额账本 ---------------------------------------------------------------
CREATE TABLE quota_account (
  user_id    CHAR(36) COLLATE ascii_bin NOT NULL,
  plan_id    VARCHAR(40) NOT NULL,
  total      INT NOT NULL,
  used       INT NOT NULL DEFAULT 0,
  reserved   INT NOT NULL DEFAULT 0,
  reset_at   DATETIME(3) NOT NULL,
  version    BIGINT NOT NULL DEFAULT 0,   -- 乐观锁备用，主用行锁
  PRIMARY KEY (user_id),
  CONSTRAINT ck_quota_total    CHECK (total >= 0),
  CONSTRAINT ck_quota_used     CHECK (used >= 0),
  CONSTRAINT ck_quota_reserved CHECK (reserved >= 0),
  -- ★超支在 DB 层不可能发生。前提：MySQL ≥ 8.0.16（此前 CHECK 被解析但忽略！）
  CONSTRAINT ck_quota_no_overdraft CHECK (used + reserved <= total),
  CONSTRAINT fk_quota_user FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE quota_reservation (
  id          CHAR(36) COLLATE ascii_bin NOT NULL,
  user_id     CHAR(36) COLLATE ascii_bin NOT NULL,
  work_id     CHAR(36) COLLATE ascii_bin NOT NULL,
  job_id      CHAR(36) COLLATE ascii_bin NULL,
  points      INT NOT NULL,
  state       ENUM('held','committed','released','expired') NOT NULL DEFAULT 'held',
  expires_at  DATETIME(3) NOT NULL,       -- 兜底自动释放（worker 失联）
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  settled_at  DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY ix_rsv_held (state, expires_at),    -- 无部分索引；state 前缀等值即可高效
  CONSTRAINT ck_rsv_points CHECK (points > 0),
  CONSTRAINT fk_rsv_user FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE quota_ledger (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id         CHAR(36) COLLATE ascii_bin NOT NULL,
  work_id         CHAR(36) COLLATE ascii_bin NULL,
  job_id          CHAR(36) COLLATE ascii_bin NULL,
  reservation_id  CHAR(36) COLLATE ascii_bin NULL,
  action          ENUM('grant','reserve','commit','release','reset','adjust') NOT NULL,
  points          INT NOT NULL,           -- 恒为正，方向由 action 决定，见 §7.2
  balance_after   INT NOT NULL,           -- 该时刻 left 快照
  idempotency_key VARCHAR(64) COLLATE ascii_bin NULL,
  note            VARCHAR(255) NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_ledger_idem (user_id, idempotency_key),   -- NULL 互不相等，无需生成列
  KEY ix_ledger_user_month (user_id, created_at DESC),
  CONSTRAINT fk_ledger_user FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE,
  CONSTRAINT fk_ledger_rsv FOREIGN KEY (reservation_id) REFERENCES quota_reservation(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ⑪ 热点 -------------------------------------------------------------------
CREATE TABLE trend (
  id           CHAR(36) COLLATE ascii_bin NOT NULL,
  domain       VARCHAR(60) NOT NULL,
  name         VARCHAR(255) NOT NULL,
  heat         DECIMAL(10,2) NULL,
  lifecycle    ENUM('rising','peaked','faded') NOT NULL,
  window_hours INT NULL,
  angles       JSON NOT NULL DEFAULT (JSON_ARRAY()),
  source       VARCHAR(120) NOT NULL,
  fetched_at   DATETIME(3) NOT NULL,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_trend_domain (domain, lifecycle, fetched_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ⑫ 自研持久队列（v1.1 新增；v1.0 历史方案为 pg-boss，MySQL 下不可用）[推断] -----
CREATE TABLE job_queue (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  queue            VARCHAR(32) COLLATE ascii_bin NOT NULL,
      -- render.draft / render.hd / render.patch / derive.media / export.pack
      -- / ai.search / ai.topics / ai.script / sys.sweep / sys.metric
  job_id           CHAR(36) COLLATE ascii_bin NULL,   -- 关联 render_job.id（系统任务为 NULL）
  user_id          CHAR(36) COLLATE ascii_bin NULL,
  payload          JSON NOT NULL DEFAULT (JSON_OBJECT()),
  state            ENUM('pending','leased','done','dead','canceled') NOT NULL DEFAULT 'pending',
  run_after        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),  -- 退避延迟可见时间
  attempt          INT NOT NULL DEFAULT 0,
  max_attempt      INT NOT NULL DEFAULT 3,
  lease_owner      VARCHAR(64) COLLATE ascii_bin NULL,   -- worker 实例 ID（hostname+pid+bootId）
  lease_expires_at DATETIME(3) NULL,                     -- 租约到期 → Sweeper 重投
  lease_token      BIGINT UNSIGNED NOT NULL DEFAULT 0,   -- fencing token，防僵尸 worker 写回
  dedup_key        VARCHAR(128) COLLATE ascii_bin NULL,  -- 自然键幂等（同 work+type+指纹）
  last_error       JSON NULL,
  created_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  started_at       DATETIME(3) NULL,
  finished_at      DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_queue_dedup (queue, dedup_key),          -- NULL 互不相等
  KEY ix_queue_pick  (queue, state, run_after, id),      -- SKIP LOCKED 拉取覆盖索引
  KEY ix_queue_lease (state, lease_expires_at),          -- Sweeper 扫过期租约
  KEY ix_queue_job   (job_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
-- 归档：state='done' 且 finished_at < NOW()-7d 的行，按天导出 JSONL 到 OSS 后批量删除；
--       state='dead'（死信）永不自动删除，必须人工处置后显式清理。

-- ⑬ 指标聚合表（v1.1 新增，替代物化视图）[推断] ----------------------------
CREATE TABLE metric_snapshot (
  metric      VARCHAR(64) COLLATE ascii_bin NOT NULL,   -- g1_e2e_p50 / g6_cost_per_work ...
  scope       VARCHAR(16) COLLATE ascii_bin NOT NULL DEFAULT 'global',
  scope_id    CHAR(36) COLLATE ascii_bin NOT NULL DEFAULT '-',   -- global 用 '-' 占位
  bucket      DATETIME(3) NOT NULL,                     -- 小时对齐
  value_num   DECIMAL(18,4) NOT NULL,
  sample_n    INT NOT NULL DEFAULT 0,
  computed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (metric, scope, scope_id, bucket),
  KEY ix_metric_bucket (metric, bucket)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ⑭ 其余支撑表 [推断] ------------------------------------------------------
CREATE TABLE idempotency_record (
  user_id      CHAR(36) COLLATE ascii_bin NOT NULL,
  `key`        VARCHAR(64) COLLATE ascii_bin NOT NULL,   -- KEY 是 MySQL 保留字
  request_hash CHAR(64) COLLATE ascii_bin NOT NULL,
  status_code  INT NULL,
  response     JSON NULL,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, `key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE analytics_event (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     CHAR(36) COLLATE ascii_bin NOT NULL,
  work_id     CHAR(36) COLLATE ascii_bin NULL,
  event       VARCHAR(64) COLLATE ascii_bin NOT NULL,    -- SPEC §11 事件名
  props       JSON NOT NULL DEFAULT (JSON_OBJECT()),
  occurred_at DATETIME(3) NOT NULL,
  ingested_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_event_work (work_id, event, occurred_at),
  KEY ix_event_time (event, occurred_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE ai_call_log (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id       CHAR(36) COLLATE ascii_bin NULL,
  work_id       CHAR(36) COLLATE ascii_bin NULL,
  job_id        CHAR(36) COLLATE ascii_bin NULL,
  port          VARCHAR(24) COLLATE ascii_bin NOT NULL,
  provider      VARCHAR(40) NOT NULL,
  model         VARCHAR(60) NOT NULL,
  input_tokens  INT NULL,
  output_tokens INT NULL,
  audio_chars   INT NULL,
  cost_cny      DECIMAL(10,4) NULL,
  latency_ms    INT NULL,
  cache_hit     TINYINT(1) NOT NULL DEFAULT 0,
  fallback_from VARCHAR(40) NULL,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_aicall_work (work_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE audit_log (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    CHAR(36) COLLATE ascii_bin NOT NULL,
  work_id    CHAR(36) COLLATE ascii_bin NULL,
  action     VARCHAR(64) COLLATE ascii_bin NOT NULL,  -- script.confirm / export.create / gate.denied
  target     VARCHAR(120) NULL,
  payload    JSON NULL,
  ip         VARCHAR(45) NULL,                        -- 原 inet；IPv6 文本形式
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_audit_user (user_id, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE voice_catalog (
  id               VARCHAR(40) COLLATE ascii_bin NOT NULL,
  provider         VARCHAR(40) NOT NULL,
  name             VARCHAR(60) NOT NULL,
  gender           VARCHAR(16) NULL,
  timbre           VARCHAR(40) NULL,
  sample_layer_key VARCHAR(512) NOT NULL,             -- 真实试听样本（D-16）
  license_evidence JSON NOT NULL,
  is_active        TINYINT(1) NOT NULL DEFAULT 1,
  ord              INT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE template_catalog (
  id           VARCHAR(40) COLLATE ascii_bin NOT NULL,
  name         VARCHAR(60) NOT NULL,
  version      INT NOT NULL,
  palette      JSON NOT NULL,
  font_family  VARCHAR(120) NOT NULL,
  page_types   JSON NOT NULL,                         -- 6 种页型
  orients      JSON NOT NULL DEFAULT (CAST('["vertical","horizontal"]' AS JSON)),
  manifest_key VARCHAR(512) NOT NULL,
  is_active    TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
