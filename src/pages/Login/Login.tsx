import React, { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Mail, Lock, Eye, EyeOff, ArrowRight, ShieldCheck, RotateCcw } from 'lucide-react';
import { signInWithEmailAndPassword, GoogleAuthProvider, signInWithPopup, signOut } from 'firebase/auth';
import { auth } from '../../config/firebase';
import { useStore } from '../../store/useStore';
import { getUserById, createOrUpdateUser } from '../../services/firestore';
import {
  sendLoginOtp,
  verifyLoginOtp,
  otpErrorMessage,
  clearOtpGateForGoogle,
  markOtpPending,
  clearOtpPending,
} from '../../services/authOtp';
import type { User } from '../../types';
import './Login.css';

const OTP_LENGTH = 6;

const Login: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // خطوة التحقق: بعد كلمة المرور يُرسل رمز إلى البريد ولا يكتمل الدخول بدونه.
  const [step, setStep] = useState<'credentials' | 'otp'>('credentials');
  const [code, setCode] = useState('');
  const [maskedEmail, setMaskedEmail] = useState('');
  const [resendIn, setResendIn] = useState(0);
  const [info, setInfo] = useState('');

  const { setUser, storeInfo } = useStore();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // علامة متبقية من محاولة سابقة لم تكتمل: الصفحة تبدأ من كلمة المرور.
  useEffect(() => {
    clearOtpPending();
  }, []);

  // عدّاد إعادة الإرسال
  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = window.setInterval(() => {
      setResendIn((seconds) => (seconds <= 1 ? 0 : seconds - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [resendIn]);

  const formatCountdown = (seconds: number): string => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  // بعد تسجيل الدخول: المشرف للوحة التحكم، والعميل للوجهة المطلوبة (مثل الدفع) أو الرئيسية
  const redirectAfterLogin = (role: string) => {
    if (role === 'admin') {
      navigate('/dashboard');
      return;
    }
    const redirect = searchParams.get('redirect');
    navigate(redirect || '/');
  };

  /** يجلب ملف المستخدم من Firestore أو ينشئه، ثم يدخله إلى المتجر. */
  const completeLogin = useCallback(async () => {
    const firebaseUser = auth.currentUser;
    if (!firebaseUser) {
      setError('انتهت الجلسة. أعد تسجيل الدخول.');
      setStep('credentials');
      return;
    }

    let userData: User | null = await getUserById(firebaseUser.uid);

    if (!userData) {
      userData = {
        id: firebaseUser.uid,
        email: firebaseUser.email || '',
        name: firebaseUser.displayName || 'مستخدم',
        role: 'customer',
        addresses: [],
        createdAt: new Date(),
      };
      await createOrUpdateUser(userData);
    }

    setUser(userData);
    redirectAfterLogin(userData.role);
  }, [setUser]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setInfo('');

    try {
      // تُمنع الجلسة من الدخول إلى المتجر حتى يُؤكَّد الرمز.
      markOtpPending();
      await signInWithEmailAndPassword(auth, email, password);

      // كلمة المرور صحيحة، لكن الدخول لا يكتمل قبل الرمز. إن فشل الإرسال
      // نُخرج المستخدم فوراً حتى لا تبقى جلسة نصف مكتملة.
      try {
        const result = await sendLoginOtp();
        setMaskedEmail(result.maskedEmail);
        setResendIn(result.resendAfterSeconds);
        setCode('');
        setStep('otp');
        setInfo(`أرسلنا رمزاً من ${OTP_LENGTH} أرقام إلى ${result.maskedEmail}`);
      } catch (otpErr) {
        clearOtpPending();
        await signOut(auth);
        setError(otpErrorMessage(otpErr, 'تعذّر إرسال رمز التحقق. حاول مرة أخرى.'));
      }
    } catch (err: unknown) {
      clearOtpPending();
      const firebaseError = err as { code?: string };
      if (firebaseError.code === 'auth/user-not-found') {
        setError('لا يوجد حساب بهذا البريد الإلكتروني');
      } else if (firebaseError.code === 'auth/wrong-password') {
        setError('كلمة المرور غير صحيحة');
      } else if (firebaseError.code === 'auth/invalid-email') {
        setError('البريد الإلكتروني غير صالح');
      } else if (firebaseError.code === 'auth/invalid-credential') {
        setError('البريد الإلكتروني أو كلمة المرور غير صحيحة');
      } else if (firebaseError.code === 'auth/too-many-requests') {
        setError('محاولات كثيرة. انتظر قليلاً ثم حاول مجدداً');
      } else {
        setError('حدث خطأ أثناء تسجيل الدخول');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (code.length !== OTP_LENGTH) {
      setError(`أدخل الرمز المكوّن من ${OTP_LENGTH} أرقام`);
      return;
    }

    setLoading(true);
    setError('');
    setInfo('');

    try {
      await verifyLoginOtp(code);
      clearOtpPending();
      await completeLogin();
    } catch (err) {
      setError(otpErrorMessage(err, 'الرمز غير صحيح أو انتهت صلاحيته'));
      setCode('');
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    if (resendIn > 0 || loading) return;

    setLoading(true);
    setError('');
    setInfo('');

    try {
      const result = await sendLoginOtp();
      setResendIn(result.resendAfterSeconds);
      setMaskedEmail(result.maskedEmail);
      setCode('');
      setInfo(
        result.sent
          ? `أرسلنا رمزاً جديداً إلى ${result.maskedEmail}`
          : 'الرمز السابق ما زال صالحاً، تحقق من بريدك',
      );
    } catch (err) {
      setError(otpErrorMessage(err, 'تعذّر إعادة إرسال الرمز. حاول لاحقاً.'));
    } finally {
      setLoading(false);
    }
  };

  /** الرجوع إلى كلمة المرور يلغي الجلسة غير المكتملة. */
  const handleBackToCredentials = async () => {
    clearOtpPending();
    await signOut(auth).catch(() => undefined);
    setStep('credentials');
    setCode('');
    setPassword('');
    setError('');
    setInfo('');
    setResendIn(0);
  };

  const handleGoogleLogin = async () => {
    setLoading(true);
    setError('');

    try {
      const provider = new GoogleAuthProvider();
      const result = await signInWithPopup(auth, provider);
      const firebaseUser = result.user;

      // Google مزوّد موثوق: نرفع حجز الرمز إن كان الحساب يحمله من محاولة
      // دخول بكلمة مرور لم تُكمل، وإلا أخرجه التطبيق بعد لحظات.
      clearOtpPending();
      await clearOtpGateForGoogle().catch((gateErr) => {
        console.error('[Auth] تعذّر رفع حجز رمز التحقق لحساب Google:', gateErr);
      });

      // جلب أو إنشاء المستخدم في Firestore
      let userData = await getUserById(firebaseUser.uid);

      if (!userData) {
        userData = {
          id: firebaseUser.uid,
          email: firebaseUser.email || '',
          name: firebaseUser.displayName || 'مستخدم',
          role: 'customer',
          addresses: [],
          createdAt: new Date()
        };
        await createOrUpdateUser(userData);
      }

      setUser(userData);

      redirectAfterLogin(userData.role);
    } catch (err: unknown) {
      const firebaseError = err as { code?: string };
      if (firebaseError.code === 'auth/popup-closed-by-user') {
        setError('تم إلغاء تسجيل الدخول');
      } else {
        setError('حدث خطأ أثناء تسجيل الدخول بـ Google');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-container">
        <Link to="/" className="back-home-btn">
          <ArrowRight size={20} />
          العودة للرئيسية
        </Link>
        <div className="login-box">
          <div className="login-header">
            <Link to="/" className="login-logo">
              <span className="logo-text">{storeInfo.storeName || "حلال"}</span>
            </Link>
            {step === 'credentials' ? (
              <>
                <h1>تسجيل الدخول</h1>
                <p>مرحباً بك مجدداً! سجل دخولك للمتابعة</p>
              </>
            ) : (
              <>
                <h1>رمز التحقق</h1>
                <p>
                  أدخل الرمز المرسل إلى <strong dir="ltr">{maskedEmail}</strong>
                </p>
              </>
            )}
          </div>

          {error && (
            <div className="alert alert-error">
              {error}
            </div>
          )}

          {info && !error && (
            <div className="alert alert-info">
              {info}
            </div>
          )}

          {step === 'credentials' ? (
            <>
              <form onSubmit={handleSubmit}>
                <div className="form-group">
                  <label className="form-label">البريد الإلكتروني</label>
                  <div className="input-icon">
                    <Mail size={20} />
                    <input
                      type="email"
                      className="form-input"
                      placeholder="example@email.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label">كلمة المرور</label>
                  <div className="input-icon">
                    <Lock size={20} />
                    <input
                      type={showPassword ? 'text' : 'password'}
                      className="form-input"
                      placeholder="••••••••"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                    />
                    <button
                      type="button"
                      className="toggle-password"
                      onClick={() => setShowPassword(!showPassword)}
                    >
                      {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
                    </button>
                  </div>
                </div>

                <div className="form-options">
                  <label className="checkbox-label">
                    <input type="checkbox" />
                    <span>تذكرني</span>
                  </label>
                  <Link to="/forgot-password" className="forgot-link">
                    نسيت كلمة المرور؟
                  </Link>
                </div>

                <button
                  type="submit"
                  className="btn btn-primary btn-lg btn-block"
                  disabled={loading}
                >
                  {loading ? 'جاري إرسال رمز التحقق...' : 'تسجيل الدخول'}
                </button>
              </form>

              <div className="login-divider">
                <span>أو</span>
              </div>

              <div className="social-login">
                <button
                  type="button"
                  className="social-btn google"
                  onClick={handleGoogleLogin}
                  disabled={loading}
                >
                  <span>G</span>
                  تسجيل بحساب Google
                </button>
              </div>

              <div className="login-footer">
                <p>
                  ليس لديك حساب؟{' '}
                  <Link to="/register">إنشاء حساب جديد</Link>
                </p>
              </div>
            </>
          ) : (
            <form onSubmit={handleVerify} className="otp-form">
              <div className="otp-badge">
                <ShieldCheck size={18} />
                <span>تحقق بخطوتين</span>
              </div>

              <div className="form-group">
                <label className="form-label">رمز التحقق</label>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  dir="ltr"
                  className="form-input otp-input"
                  placeholder="______"
                  maxLength={OTP_LENGTH}
                  value={code}
                  onChange={(e) =>
                    setCode(e.target.value.replace(/\D/g, '').slice(0, OTP_LENGTH))
                  }
                  autoFocus
                  required
                />
                <p className="otp-hint">
                  الرمز صالح لمدة 5 دقائق. تحقق من مجلد الرسائل غير المرغوبة إن لم يصل.
                </p>
              </div>

              <button
                type="submit"
                className="btn btn-primary btn-lg btn-block"
                disabled={loading || code.length !== OTP_LENGTH}
              >
                {loading ? 'جاري التحقق...' : 'تأكيد وتسجيل الدخول'}
              </button>

              <div className="otp-actions">
                <button
                  type="button"
                  className="otp-resend"
                  onClick={handleResend}
                  disabled={resendIn > 0 || loading}
                >
                  <RotateCcw size={16} />
                  {resendIn > 0
                    ? `إعادة الإرسال بعد ${formatCountdown(resendIn)}`
                    : 'إعادة إرسال الرمز'}
                </button>

                <button
                  type="button"
                  className="otp-back"
                  onClick={handleBackToCredentials}
                  disabled={loading}
                >
                  تغيير البريد أو كلمة المرور
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};

export default Login;
