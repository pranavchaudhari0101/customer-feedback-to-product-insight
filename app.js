/**
 * Customer Feedback Web Application
 * Minimalist Tech / INSEC Theme
 * - Validated submit, proper HTTP status checks, timeout + retry
 * - Client-side rate limiting (cooldown + hourly/daily caps)
 * - n8n webhook integration with enriched payload
 */

// Allow override without editing code (e.g. Vercel env injection):
//   <script>window.FEEDBACK_WEBHOOK_URL="https://..."</script>
const WEBHOOK_URL = window.FEEDBACK_WEBHOOK_URL || 'https://pranav277.app.n8n.cloud/webhook/product-feedback';

// Limits & tuning
const MAX_FEEDBACK_LEN = 1500;
const MIN_FEEDBACK_LEN = 5;
const REQUEST_TIMEOUT_MS = 15000;
const COOLDOWN_SECONDS = 30;
const MAX_PER_HOUR = 5;
const MAX_PER_DAY = 20;
const DUPLICATE_WINDOW_MS = 5 * 60 * 1000;

const LS_TIMES_KEY = 'fb_submit_times';
const LS_LAST_KEY = 'fb_last_submit';
const LS_TEXT_KEY = 'fb_last_text';

// Rating text labels
const RATING_LABELS = {
  1: '1/5 — Frustrating',
  2: '2/5 — Disappointing',
  3: '3/5 — Neutral',
  4: '4/5 — Good',
  5: '5/5 — Excellent'
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Subtle Web Audio synthesizer for tactile UI feedback
class SoundFX {
  constructor() {
    this.ctx = null;
  }

  init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) this.ctx = new AudioCtx();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  playPop(freq = 520) {
    try {
      this.init();
      if (!this.ctx) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(freq * 1.5, this.ctx.currentTime + 0.08);
      gain.gain.setValueAtTime(0.04, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.08);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start();
      osc.stop(this.ctx.currentTime + 0.09);
    } catch (e) {}
  }

  playSuccess() {
    try {
      this.init();
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      [440, 554.37, 659.25, 880].forEach((freq, i) => {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, now + i * 0.07);
        gain.gain.setValueAtTime(0.06, now + i * 0.07);
        gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.07 + 0.22);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(now + i * 0.07);
        osc.stop(now + i * 0.07 + 0.24);
      });
    } catch (e) {}
  }
}

const sfx = new SoundFX();

// DOM Elements
const form = document.getElementById('feedbackForm');
const feedbackText = document.getElementById('feedbackText');
const feedbackError = document.getElementById('feedbackError');
const charCount = document.getElementById('charCount');
const ratingInput = document.getElementById('ratingInput');
const ratingScoreText = document.getElementById('ratingScoreText');
const ratingError = document.getElementById('ratingError');
const ratingContainer = document.getElementById('ratingContainer');
const clearRatingBtn = document.getElementById('clearRatingBtn');
const starBtns = document.querySelectorAll('.star-btn');
const sourceSelect = document.getElementById('sourceSelect');
const sourceError = document.getElementById('sourceError');
const userSegmentSelect = document.getElementById('userSegmentSelect');
const segmentError = document.getElementById('segmentError');
const emailInput = document.getElementById('emailInput');
const emailError = document.getElementById('emailError');
const honeypotInput = document.getElementById('companyWebsite');
const rateLimitNote = document.getElementById('rateLimitNote');
const submitBtn = document.getElementById('submitBtn');
const btnLabel = submitBtn ? submitBtn.querySelector('.btn-label') : null;
const toastStack = document.getElementById('toastStack');
const successScreen = document.getElementById('successScreen');
const sendAnotherBtn = document.getElementById('sendAnotherBtn');
const navGiveFeedback = document.getElementById('navGiveFeedback');

// State
let selectedRating = null;
let cooldownTimer = null;

// Initialize Lucide icons
if (window.lucide) {
  window.lucide.createIcons();
}

/* ---------------- Rate limiting (localStorage) ---------------- */

function loadSubmitTimes() {
  try {
    const raw = localStorage.getItem(LS_TIMES_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((t) => typeof t === 'number') : [];
  } catch (e) {
    return [];
  }
}

function saveSubmitTimes(times) {
  try {
    localStorage.setItem(LS_TIMES_KEY, JSON.stringify(times));
  } catch (e) {}
}

function pruneTimes(times, now) {
  const dayAgo = now - 24 * 60 * 60 * 1000;
  return times.filter((t) => t > dayAgo);
}

function getRateLimitStatus() {
  const now = Date.now();
  const last = Number(localStorage.getItem(LS_LAST_KEY) || 0);
  const cooldownRemaining = Math.max(0, Math.ceil((last + COOLDOWN_SECONDS * 1000 - now) / 1000));
  const times = pruneTimes(loadSubmitTimes(), now);
  const hourAgo = now - 60 * 60 * 1000;
  const lastHour = times.filter((t) => t > hourAgo).length;
  return {
    now,
    last,
    cooldownRemaining,
    lastHour,
    lastDay: times.length,
    times
  };
}

function recordSubmission(now, text) {
  const status = getRateLimitStatus();
  const times = [...status.times, now];
  saveSubmitTimes(pruneTimes(times, now));
  try {
    localStorage.setItem(LS_LAST_KEY, String(now));
    localStorage.setItem(LS_TEXT_KEY, text);
  } catch (e) {}
}

function checkRateLimit(feedbackValue) {
  const s = getRateLimitStatus();
  if (s.cooldownRemaining > 0) {
    return { blocked: true, reason: 'cooldown', retryAfter: s.cooldownRemaining };
  }
  if (s.lastHour >= MAX_PER_HOUR) {
    return { blocked: true, reason: 'hourly' };
  }
  if (s.lastDay >= MAX_PER_DAY) {
    return { blocked: true, reason: 'daily' };
  }
  try {
    const lastText = localStorage.getItem(LS_TEXT_KEY) || '';
    if (lastText && lastText === feedbackValue && s.now - s.last < DUPLICATE_WINDOW_MS) {
      return { blocked: true, reason: 'duplicate' };
    }
  } catch (e) {}
  return { blocked: false };
}

function updateRateLimitNote() {
  if (!rateLimitNote) return;
  const s = getRateLimitStatus();
  if (s.cooldownRemaining > 0) {
    rateLimitNote.textContent = `Please wait ${s.cooldownRemaining}s before submitting again (${s.lastHour}/${MAX_PER_HOUR} this hour).`;
    rateLimitNote.classList.add('cooldown');
  } else if (s.lastHour > 0) {
    rateLimitNote.textContent = `${s.lastHour}/${MAX_PER_HOUR} submissions this hour.`;
    rateLimitNote.classList.remove('cooldown');
  } else {
    rateLimitNote.textContent = '';
    rateLimitNote.classList.remove('cooldown');
  }
}

function startCooldownTicker() {
  updateRateLimitNote();
  if (cooldownTimer) clearInterval(cooldownTimer);
  cooldownTimer = setInterval(() => {
    updateRateLimitNote();
    const s = getRateLimitStatus();
    if (s.cooldownRemaining <= 0 && submitBtn && !submitBtn.classList.contains('loading')) {
      if (btnLabel) btnLabel.textContent = 'Submit feedback';
      submitBtn.disabled = false;
      clearInterval(cooldownTimer);
      cooldownTimer = null;
    }
  }, 1000);
}

/* ---------------- Helpers ---------------- */

function getTodayDateString() {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function generateFeedbackId() {
  return `FB-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

function sanitizeFeedback(value) {
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_FEEDBACK_LEN);
}

function showFieldError(errorEl, wrapEl) {
  if (errorEl) errorEl.classList.add('visible');
  if (wrapEl) wrapEl.classList.add('error');
}

function hideFieldError(errorEl, wrapEl) {
  if (errorEl) errorEl.classList.remove('visible');
  if (wrapEl) wrapEl.classList.remove('error');
}

function shake(el) {
  if (window.gsap && el) {
    gsap.fromTo(el, { x: -6 }, { x: 6, duration: 0.08, repeat: 3, yoyo: true, clearProps: 'x' });
  }
}

/* ---------------- Star Rating Picker ---------------- */

function setRatingAria() {
  starBtns.forEach((btn) => {
    const val = parseInt(btn.dataset.value, 10);
    btn.setAttribute('aria-checked', selectedRating === val ? 'true' : 'false');
  });
}

starBtns.forEach((btn) => {
  const val = parseInt(btn.dataset.value, 10);

  btn.addEventListener('mouseenter', () => {
    highlightStars(val, false);
    ratingScoreText.textContent = RATING_LABELS[val];
  });

  btn.addEventListener('mouseleave', () => {
    if (selectedRating) {
      highlightStars(selectedRating, true);
      ratingScoreText.textContent = RATING_LABELS[selectedRating];
    } else {
      clearStarsHover();
      ratingScoreText.textContent = 'Tap to rate experience';
    }
  });

  btn.addEventListener('click', () => {
    sfx.playPop(420 + val * 50);
    selectedRating = val;
    ratingInput.value = val;
    highlightStars(val, true);
    setRatingAria();
    ratingScoreText.textContent = RATING_LABELS[val];
    clearRatingBtn.style.display = 'flex';
    hideFieldError(ratingError, ratingContainer);

    if (window.gsap) {
      gsap.fromTo(btn.querySelector('.star-icon'),
        { scale: 0.7 },
        { scale: 1.25, duration: 0.2, yoyo: true, repeat: 1, ease: 'back.out(2)', clearProps: 'scale' }
      );
    }
  });
});

function highlightStars(count, isPermanent) {
  starBtns.forEach((btn) => {
    const val = parseInt(btn.dataset.value, 10);
    if (val <= count) {
      if (isPermanent) {
        btn.classList.add('active');
        btn.classList.remove('hovered');
      } else {
        btn.classList.add('hovered');
      }
    } else {
      btn.classList.remove('active', 'hovered');
    }
  });
}

function clearStarsHover() {
  starBtns.forEach((btn) => {
    btn.classList.remove('hovered');
    if (!selectedRating) {
      btn.classList.remove('active');
    }
  });
}

clearRatingBtn.addEventListener('click', () => {
  sfx.playPop(300);
  selectedRating = null;
  ratingInput.value = '';
  setRatingAria();
  starBtns.forEach((btn) => btn.classList.remove('active', 'hovered'));
  clearRatingBtn.style.display = 'none';
  ratingScoreText.textContent = 'Tap to rate experience';
});

/* ---------------- Inputs: counters & live error clear ---------------- */

feedbackText.addEventListener('input', () => {
  if (feedbackText.value.length > MAX_FEEDBACK_LEN) {
    feedbackText.value = feedbackText.value.slice(0, MAX_FEEDBACK_LEN);
  }
  const len = feedbackText.value.length;
  charCount.textContent = len;

  if (len > 0) {
    hideFieldError(feedbackError, feedbackText.closest('.input-box-wrap'));
  }
  charCount.style.color = len > 1400 ? '#ef4444' : 'var(--text-placeholder)';
});

sourceSelect.addEventListener('change', () => {
  hideFieldError(sourceError, sourceSelect.closest('.select-box-wrap'));
});

userSegmentSelect.addEventListener('change', () => {
  hideFieldError(segmentError, userSegmentSelect.closest('.select-box-wrap'));
});

emailInput.addEventListener('input', () => {
  hideFieldError(emailError, emailInput.closest('.input-box-wrap'));
});

/* ---------------- Nav ---------------- */

function focusFeedbackForm() {
  const card = document.getElementById('formCard');
  if (successScreen && successScreen.style.display === 'block') {
    showToast('Form already submitted — send another to write more', 'info');
    return;
  }
  if (card && card.scrollIntoView) {
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  setTimeout(() => feedbackText.focus({ preventScroll: true }), 350);
}

if (navGiveFeedback) {
  navGiveFeedback.addEventListener('click', () => {
    sfx.playPop(500);
    focusFeedbackForm();
  });
}

document.querySelectorAll('[data-scroll]').forEach((a) => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    focusFeedbackForm();
  });
});

document.querySelectorAll('[data-soon]').forEach((a) => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    showToast('This section is coming soon', 'info');
  });
});

/* ---------------- Toast ---------------- */

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `minimal-toast ${type}`;
  toast.textContent = message;

  toastStack.appendChild(toast);
  while (toastStack.children.length > 4) {
    toastStack.firstChild.remove();
  }

  setTimeout(() => {
    if (window.gsap) {
      gsap.to(toast, {
        opacity: 0,
        y: 8,
        duration: 0.25,
        onComplete: () => toast.remove()
      });
    } else {
      toast.remove();
    }
  }, 4000);
}

function triggerCelebration() {
  if (typeof confetti === 'function') {
    confetti({
      particleCount: 65,
      spread: 60,
      origin: { y: 0.6 },
      colors: ['#10b981', '#f97316', '#38bdf8', '#fbbf24']
    });
  }
}

/* ---------------- n8n POST with timeout + status check ---------------- */

async function postToN8n(payload, { timeoutMs = REQUEST_TIMEOUT_MS, retries = 1 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      clearTimeout(timer);

      if (!res.ok) {
        let detail = '';
        try {
          detail = (await res.text()).slice(0, 300);
        } catch (e) {}
        const err = new Error(`Server responded with ${res.status}`);
        err.status = res.status;
        err.detail = detail;
        throw err;
      }
      // n8n may return empty body — tolerate it
      const text = await res.text().catch(() => '');
      if (!text) return { ok: true };
      try {
        return JSON.parse(text);
      } catch (e) {
        return { ok: true, raw: text };
      }
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      // Don't retry client errors (4xx) or aborts caused by validation
      if (err && err.status && err.status >= 400 && err.status < 500) break;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function friendlySubmitError(err) {
  if (err && err.name === 'AbortError') {
    return 'Request timed out. Please check your connection and try again.';
  }
  if (err && err.status === 404) {
    return 'Feedback endpoint not found (404). The n8n webhook may be inactive — check n8n.';
  }
  if (err && err.status === 410) {
    return 'n8n webhook is inactive. Open the n8n workflow and activate it, then retry.';
  }
  if (err && err.status) {
    return `Submit failed (HTTP ${err.status}). Please try again.`;
  }
  if (err instanceof TypeError) {
    return 'Network/CORS error. If testing locally, serve over http://localhost and enable CORS in the n8n Webhook node.';
  }
  return 'Failed to submit feedback. Check network and try again.';
}

/* ---------------- Validation ---------------- */

function validateForm(feedbackValue) {
  let ok = true;
  let firstBad = null;

  const markBad = (errorEl, wrapEl, groupId) => {
    showFieldError(errorEl, wrapEl);
    shake(document.getElementById(groupId));
    ok = false;
    if (!firstBad && wrapEl) firstBad = wrapEl;
  };

  // Rating (required)
  if (!selectedRating) {
    markBad(ratingError, ratingContainer, 'groupRating');
  } else {
    hideFieldError(ratingError, ratingContainer);
  }

  // Source (required)
  if (!sourceSelect.value) {
    markBad(sourceError, sourceSelect.closest('.select-box-wrap'), 'groupSource');
  } else {
    hideFieldError(sourceError, sourceSelect.closest('.select-box-wrap'));
  }

  // Segment (required)
  if (!userSegmentSelect.value) {
    markBad(segmentError, userSegmentSelect.closest('.select-box-wrap'), 'groupUserSegment');
  } else {
    hideFieldError(segmentError, userSegmentSelect.closest('.select-box-wrap'));
  }

  // Email (optional, but must be valid if present)
  const emailVal = emailInput.value.trim();
  if (emailVal && !EMAIL_RE.test(emailVal)) {
    markBad(emailError, emailInput.closest('.input-box-wrap'), 'groupEmail');
  } else {
    hideFieldError(emailError, emailInput.closest('.input-box-wrap'));
  }

  // Feedback (required, min/max)
  if (!feedbackValue || feedbackValue.length < MIN_FEEDBACK_LEN) {
    if (feedbackError) {
      feedbackError.querySelector('span').textContent =
        `Please enter at least ${MIN_FEEDBACK_LEN} characters of feedback (max ${MAX_FEEDBACK_LEN}).`;
    }
    markBad(feedbackError, feedbackText.closest('.input-box-wrap'), 'groupFeedback');
  } else if (feedbackValue.length > MAX_FEEDBACK_LEN) {
    markBad(feedbackError, feedbackText.closest('.input-box-wrap'), 'groupFeedback');
  } else {
    hideFieldError(feedbackError, feedbackText.closest('.input-box-wrap'));
  }

  return { ok, firstBad };
}

/* ---------------- Form Submit Handler ---------------- */

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  // Honeypot: pretend success for bots, never send
  if (honeypotInput && honeypotInput.value) {
    showFakeSuccess();
    return;
  }

  const rawValue = feedbackText.value;
  const feedbackValue = sanitizeFeedback(rawValue.trim());
  // Reflect sanitized value (enforces 1500 cap)
  if (rawValue.trim() !== feedbackValue) {
    feedbackText.value = feedbackValue;
    charCount.textContent = feedbackValue.length;
  }

  // Validate
  const { ok, firstBad } = validateForm(feedbackValue);
  if (!ok) {
    sfx.playPop(220);
    const messages = [];
    if (!selectedRating) messages.push('rating');
    if (!sourceSelect.value) messages.push('channel');
    if (!userSegmentSelect.value) messages.push('profile');
    if (!feedbackValue || feedbackValue.length < MIN_FEEDBACK_LEN) messages.push('feedback');
    const emailVal = emailInput.value.trim();
    if (emailVal && !EMAIL_RE.test(emailVal)) messages.push('valid email');
    showToast(`Please complete: ${messages.join(', ')}`, 'error');
    if (firstBad && firstBad.scrollIntoView) {
      firstBad.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
      feedbackText.focus();
    }
    return;
  }

  // Rate limiting
  const rl = checkRateLimit(feedbackValue);
  if (rl.blocked) {
    sfx.playPop(220);
    if (rl.reason === 'cooldown') {
      showToast(`Slow down — retry in ${rl.retryAfter}s`, 'error');
      startCooldownTicker();
    } else if (rl.reason === 'hourly') {
      showToast(`Hourly limit reached (${MAX_PER_HOUR}/hour). Try later.`, 'error');
    } else if (rl.reason === 'daily') {
      showToast(`Daily limit reached (${MAX_PER_DAY}/day). Try tomorrow.`, 'error');
    } else if (rl.reason === 'duplicate') {
      showToast('Duplicate feedback detected. Please edit before resending.', 'error');
    }
    return;
  }

  // Payload for n8n — `feedback` array kept for backwards compatibility,
  // extra context fields help routing/triage in n8n.
  const emailVal = emailInput.value.trim();
  const now = new Date();
  const finalPayload = {
    feedback: [
      {
        id: generateFeedbackId(),
        source: sourceSelect.value,
        user_segment: userSegmentSelect.value,
        date: getTodayDateString(),
        submitted_at: now.toISOString(),
        rating: Number(selectedRating),
        feedback: feedbackValue,
        email: emailVal && EMAIL_RE.test(emailVal) ? emailVal : null,
        page_url: location.href,
        user_agent: navigator.userAgent
      }
    ]
  };

  submitBtn.classList.add('loading');
  submitBtn.disabled = true;
  if (btnLabel) btnLabel.textContent = 'Sending...';

  try {
    await postToN8n(finalPayload, { timeoutMs: REQUEST_TIMEOUT_MS, retries: 1 });
    recordSubmission(Date.now(), feedbackValue);
    showRealSuccess(finalPayload.feedback[0]);
  } catch (err) {
    console.error('Submission error:', err);
    showToast(friendlySubmitError(err), 'error');
  } finally {
    submitBtn.classList.remove('loading');
    // Respect cooldown even after success/failure UI
    const s = getRateLimitStatus();
    if (s.cooldownRemaining > 0) {
      startCooldownTicker();
    } else {
      submitBtn.disabled = false;
      if (btnLabel) btnLabel.textContent = 'Submit feedback';
      updateRateLimitNote();
    }
  }
});

function showRealSuccess(item) {
  sfx.playSuccess();
  triggerCelebration();

  document.getElementById('receiptId').textContent = item.id;
  document.getElementById('receiptDate').textContent = item.date;
  document.getElementById('receiptChannel').textContent = item.source;
  document.getElementById('receiptSegment').textContent = item.user_segment;
  document.getElementById('receiptRating').textContent = `${item.rating}/5 ★`;

  transitionToSuccess();
  showToast('Feedback submitted successfully', 'success');
}

// Used for honeypot bots — no network call, same UI so bots can't tell
function showFakeSuccess() {
  const fake = {
    id: generateFeedbackId(),
    date: getTodayDateString(),
    source: sourceSelect.value || 'Website',
    user_segment: userSegmentSelect.value || 'Unknown',
    rating: selectedRating || 5
  };
  document.getElementById('receiptId').textContent = fake.id;
  document.getElementById('receiptDate').textContent = fake.date;
  document.getElementById('receiptChannel').textContent = fake.source;
  document.getElementById('receiptSegment').textContent = fake.user_segment;
  document.getElementById('receiptRating').textContent = `${fake.rating}/5 ★`;
  transitionToSuccess();
}

function transitionToSuccess() {
  if (window.gsap && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    gsap.to(form, {
      opacity: 0,
      duration: 0.25,
      onComplete: () => {
        form.style.display = 'none';
        successScreen.style.display = 'block';
        gsap.fromTo(successScreen,
          { opacity: 0, y: 15 },
          { opacity: 1, y: 0, duration: 0.35, ease: 'power2.out' }
        );
        if (window.lucide) window.lucide.createIcons();
      }
    });
  } else {
    form.style.display = 'none';
    successScreen.style.display = 'block';
    if (window.lucide) window.lucide.createIcons();
  }
}

/* ---------------- Reset & Submit Another ---------------- */

sendAnotherBtn.addEventListener('click', () => {
  sfx.playPop(480);
  form.reset();
  selectedRating = null;
  ratingInput.value = '';
  setRatingAria();
  charCount.textContent = '0';
  charCount.style.color = 'var(--text-placeholder)';
  starBtns.forEach((btn) => btn.classList.remove('active', 'hovered'));
  clearRatingBtn.style.display = 'none';
  ratingScoreText.textContent = 'Tap to rate experience';
  [feedbackError, ratingError, sourceError, segmentError, emailError].forEach((el) => {
    if (el) el.classList.remove('visible');
  });
  document.querySelectorAll('.input-box-wrap.error, .select-box-wrap.error, .stars-picker.error')
    .forEach((el) => el.classList.remove('error'));

  const showForm = () => {
    successScreen.style.display = 'none';
    form.style.display = 'block';
    if (window.gsap && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      gsap.fromTo(form, { opacity: 0 }, { opacity: 1, duration: 0.3, clearProps: 'opacity' });
    } else {
      form.style.opacity = 1;
    }
    updateRateLimitNote();
    feedbackText.focus();
  };

  if (window.gsap && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    gsap.to(successScreen, { opacity: 0, duration: 0.2, onComplete: showForm });
  } else {
    showForm();
  }
});

/* ---------------- Entrance Animations + init ---------------- */

window.addEventListener('DOMContentLoaded', () => {
  setRatingAria();
  charCount.textContent = feedbackText.value.length;
  updateRateLimitNote();
  startCooldownTicker();

  if (window.gsap && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const tl = gsap.timeline({ defaults: { ease: 'power2.out' } });

    tl.from('.tile-logo', { opacity: 0, scale: 0.8, duration: 0.4 })
      .from('.hero-title', { opacity: 0, y: 20, duration: 0.5 }, '-=0.2')
      .from('.hero-subtitle', { opacity: 0, y: 15, duration: 0.4 }, '-=0.2')
      .from('.glass-form-card', { opacity: 0, y: 25, duration: 0.6, ease: 'power3.out' }, '-=0.3')
      .from('.form-group', { opacity: 0, y: 10, duration: 0.3, stagger: 0.05 }, '-=0.2')
      .from('.join-btn', { opacity: 0, y: 10, duration: 0.3 }, '-=0.1');
  }
  if (window.lucide) window.lucide.createIcons();
});
