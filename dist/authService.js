(function () {
  'use strict';

  let client = null;
  let subscription = null;
  let initialized = false;
  let demoMode = false;
  let demoSession = null;
  let authListener = null;

  const DEMO_EMAIL = 'demo@visionguide.local';
  const DEMO_PASSWORD = 'visionguide';
  const DEMO_STORAGE_KEY = 'visionguide-demo-session';

  function storage() {
    try { return window.localStorage; } catch { return null; }
  }

  function createDemoSession() {
    return {
      access_token: 'local-demo-session',
      user: { id: 'demo-user', email: DEMO_EMAIL, user_metadata: { display_name: 'Demo User' } }
    };
  }

  function demoError(message, code = 'demo_mode') {
    return { data: { session: null }, error: { code, message } };
  }

  function requireClient() {
    if (!client) throw new Error('Authentication is not configured.');
    return client;
  }

  function redirectUrl() {
    return `${window.location.origin}/`;
  }

  async function initialize(onAuthChange) {
    authListener = onAuthChange;
    if (initialized) {
      if (demoMode) return demoSession;
      const { data } = await requireClient().auth.getSession();
      return data.session;
    }
    if (!window.supabase?.createClient) throw new Error('The authentication client could not load.');

    const response = await window.fetch('/api/public-config', { headers: { Accept: 'application/json' } });
    const config = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error('Authentication configuration could not be loaded.');
    if (!config.supabase?.configured) {
      demoMode = true;
      initialized = true;
      if (storage()?.getItem(DEMO_STORAGE_KEY) === 'signed-in') demoSession = createDemoSession();
      return demoSession;
    }

    client = window.supabase.createClient(config.supabase.url, config.supabase.publishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storageKey: 'visionguide-auth-session'
      }
    });
    initialized = true;
    const result = client.auth.onAuthStateChange((event, session) => {
      window.setTimeout(() => onAuthChange?.(event, session), 0);
    });
    subscription = result.data.subscription;
    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    return data.session;
  }

  async function signUp({ name, email, password }) {
    if (demoMode) return demoError('Account creation is unavailable in local demo mode. Use the demo login shown on the sign-in page.');
    return requireClient().auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: redirectUrl(),
        data: { display_name: name }
      }
    });
  }

  async function signIn({ email, password }) {
    if (demoMode) {
      const validEmail = String(email || '').trim().toLowerCase() === DEMO_EMAIL;
      if (!validEmail || password !== DEMO_PASSWORD)
        return demoError('Invalid login credentials', 'invalid_credentials');
      demoSession = createDemoSession();
      storage()?.setItem(DEMO_STORAGE_KEY, 'signed-in');
      window.setTimeout(() => authListener?.('SIGNED_IN', demoSession), 0);
      return { data: { session: demoSession }, error: null };
    }
    return requireClient().auth.signInWithPassword({ email, password });
  }

  async function requestPasswordReset(email) {
    if (demoMode) return demoError('Password recovery is unavailable in local demo mode.');
    return requireClient().auth.resetPasswordForEmail(email, { redirectTo: redirectUrl() });
  }

  async function updatePassword(password) {
    if (demoMode) return demoError('Password changes are unavailable in local demo mode.');
    return requireClient().auth.updateUser({ password });
  }

  async function signOut() {
    if (demoMode) {
      demoSession = null;
      storage()?.removeItem(DEMO_STORAGE_KEY);
      window.setTimeout(() => authListener?.('SIGNED_OUT', null), 0);
      return { error: null };
    }
    return requireClient().auth.signOut({ scope: 'local' });
  }

  async function getAccessToken() {
    if (demoMode) throw new Error('Automatic SOS is unavailable in local demo mode. Configure Supabase to enable authenticated server actions.');
    const { data, error } = await requireClient().auth.getSession();
    if (error) throw error;
    if (!data.session?.access_token) throw new Error('Your session has expired. Sign in again.');
    return data.session.access_token;
  }

  function destroy() {
    subscription?.unsubscribe?.();
    subscription = null;
  }

  function isDemoMode() { return demoMode; }

  window.supabaseAuth = { initialize, signUp, signIn, requestPasswordReset, updatePassword, signOut, getAccessToken, destroy, isDemoMode };
})();
