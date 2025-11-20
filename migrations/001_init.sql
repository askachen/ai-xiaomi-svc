-- ========== USERS ==========
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  line_user_id TEXT UNIQUE,
  display_name TEXT,
  avatar_url TEXT,
  email TEXT,
  phone TEXT,
  membership_plan TEXT,
  subscription_status TEXT,
  current_subscription_id INTEGER,
  created_at TEXT,
  updated_at TEXT
);

-- ========== CHAT LOGS ==========
-- ERD 的 chat_messages，我改名成 chat_logs 方便你的 API 使用
CREATE TABLE chat_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  session_id TEXT,
  direction TEXT,          -- user/bot/system
  message_type TEXT,       -- text/image/audio
  text_content TEXT,
  media_url TEXT,
  raw_payload TEXT,
  created_at TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

-- ========== DAILY HEALTH LOGS ==========
CREATE TABLE daily_health_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  log_date TEXT,
  mood INTEGER,
  energy_level INTEGER,
  sleep_hours REAL,
  weight_kg REAL,
  body_fat_pct REAL,
  steps INTEGER,
  notes TEXT,
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

-- ========== EULA VERSIONS ==========
CREATE TABLE eula_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version TEXT,
  url TEXT,
  content_hash TEXT,
  effective_from TEXT,
  created_at TEXT
);

-- ========== EULA ACCEPTANCES ==========
CREATE TABLE eula_acceptances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  eula_version_id INTEGER,
  accepted_at TEXT,
  channel TEXT,
  ip_address TEXT,
  user_agent TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(eula_version_id) REFERENCES eula_versions(id)
);

-- ========== SUBSCRIPTIONS ==========
CREATE TABLE subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  plan_code TEXT,
  status TEXT,
  price_ntd INTEGER,
  currency TEXT,
  billing_period TEXT,
  started_at TEXT,
  ended_at TEXT,
  renews_at TEXT,
  provider TEXT,
  provider_sub_id TEXT,
  provider_txn_id TEXT,
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

-- ========== MEAL LOGS ==========
CREATE TABLE meal_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  eaten_at TEXT,
  meal_type TEXT,
  food_name TEXT,
  description TEXT,
  carb_g REAL,
  sugar_g REAL,
  protein_g REAL,
  fat_g REAL,
  veggies_servings REAL,
  fruits_servings REAL,
  calories_kcal REAL,
  photo_url TEXT,
  source TEXT,
  metadata TEXT,
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

-- ========== DIET PLANS ==========
CREATE TABLE diet_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  name TEXT,
  description TEXT,
  target_calories_per_day REAL,
  carb_ratio REAL,
  protein_ratio REAL,
  fat_ratio REAL,
  notes TEXT,
  is_active INTEGER,
  start_date TEXT,
  end_date TEXT,
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

-- ========== WEIGHT LOSS PLANS ==========
CREATE TABLE weight_loss_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  name TEXT,
  start_date TEXT,
  start_weight_kg REAL,
  target_weight_kg REAL,
  target_date TEXT,
  status TEXT,
  is_active INTEGER,
  created_at TEXT,
  updated_at TEXT,
  completed_at TEXT,
  cancelled_at TEXT,
  notes TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

-- ========== USER PREFERENCES ==========
CREATE TABLE user_preferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER UNIQUE,
  language TEXT,
  timezone TEXT,
  measurement_unit TEXT,
  preferred_food_style TEXT,
  dietary_restrictions TEXT,
  allergies TEXT,
  notification_enabled INTEGER,
  notification_hour INTEGER,
  coach_tone TEXT,
  other_settings TEXT,
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

-- ========== FEEDBACKS ==========
CREATE TABLE feedbacks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  source TEXT,
  feedback_type TEXT,
  rating INTEGER,
  message TEXT,
  meta TEXT,
  handled INTEGER,
  handled_at TEXT,
  handler_note TEXT,
  created_at TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

-- ========== REFERRAL CODES ==========
CREATE TABLE referral_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE,
  discount_percent INTEGER,
  status TEXT,
  max_uses INTEGER,
  current_uses INTEGER,
  expires_at TEXT,
  created_by_user_id INTEGER,
  notes TEXT,
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY(created_by_user_id) REFERENCES users(id)
);

-- ========== REFERRAL USAGES ==========
CREATE TABLE referral_usages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referral_code_id INTEGER,
  user_id INTEGER,
  subscription_id INTEGER,
  used_at TEXT,
  discount_amount_ntd INTEGER,
  created_at TEXT,
  FOREIGN KEY(referral_code_id) REFERENCES referral_codes(id),
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(subscription_id) REFERENCES subscriptions(id)
);

-- ========== ISSUE REPORTS ==========
CREATE TABLE issue_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  title TEXT,
  description TEXT,
  category TEXT,
  severity TEXT,
  status TEXT,
  attachments TEXT,
  metadata TEXT,
  created_at TEXT,
  updated_at TEXT,
  resolved_at TEXT,
  assignee TEXT,
  admin_note TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
