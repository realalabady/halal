import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Product, CartItem, User } from "../types";

export interface StoreInfo {
  storeName: string;
  storeEmail: string;
  storePhone: string;
  storeAddress: string;
  currency: string;
  language: string;
  /** بيانات التحويل البنكي — تُضبط من لوحة التحكم، ولا تُكتب في الكود. */
  bankName: string;
  bankIban: string;
}

/**
 * الهوية النظامية للمتجر — ما يُطبع على الفاتورة.
 *
 * منفصلة عن StoreInfo عن قصد: StoreInfo هي واجهة المتجر (اسم، بريد، هاتف)،
 * وهذه وثائقه النظامية (سجل تجاري، رقم ضريبي، اسم قانوني). دمجهما يجعل كل
 * حقل نظامي يظهر في كل مكان يقرأ storeInfo اليوم.
 */
export interface BusinessInfo {
  /** الاسم القانوني كما في السجل التجاري */
  legalNameAr: string;
  legalNameEn: string;
  /** رقم السجل التجاري */
  crNumber: string;
  /** الرقم الموحّد للمنشأة (٧٠٠…) */
  unifiedNumber: string;
  /** رابط التحقق من السجل في المركز السعودي للأعمال — يصير رمز QR على الفاتورة */
  crVerifyUrl: string;
  addressAr: string;
  addressEn: string;
  /** بادئة الرقم التسلسلي للفاتورة */
  invoicePrefix: string;
  /** سطر حرّ أسفل الفاتورة (سياسة إرجاع، شروط) */
  invoiceNotes: string;
  /** شعار يُطبع في رأس الفاتورة. فارغ ⇒ يُرسم اسم المتجر نصّاً. */
  logoUrl: string;
  /** لا تُفعّل إلا مع رقم ضريبي صحيح — انظر تبويب الفاتورة في الإعدادات */
  vatEnabled: boolean;
  vatNumber: string;
  vatRate: number;
  /** أسعار المتجر شاملة الضريبة (الممارسة السعودية المعتادة) */
  pricesIncludeVat: boolean;
}

/**
 * قيم ابتدائية فارغة للحقول النظامية.
 *
 * فارغة لا مُختلقة: رقم سجل تجاري مكتوب في الكود يُطبع على فاتورة حقيقية
 * ويُقدَّم لجهة حكومية. الفاتورة تُخفي كل حقل فارغ، وتبويب الإعدادات هو
 * المكان الذي يملأ منه التاجر هويته.
 */
export const DEFAULT_BUSINESS_INFO: BusinessInfo = {
  legalNameAr: "",
  legalNameEn: "",
  crNumber: "",
  unifiedNumber: "",
  crVerifyUrl: "",
  addressAr: "",
  addressEn: "",
  invoicePrefix: "HLY",
  invoiceNotes: "",
  logoUrl: "",
  vatEnabled: false,
  vatNumber: "",
  vatRate: 15,
  pricesIncludeVat: true,
};

export const DEFAULT_STORE_INFO: StoreInfo = {
  storeName: "حلال",
  storeEmail: "",
  storePhone: "",
  storeAddress: "",
  currency: "SAR",
  language: "ar",
  bankName: "",
  bankIban: "",
};

interface StoreState {
  // Cart (يبقى محلي لأنه خاص بالمستخدم الحالي)
  cart: CartItem[];
  addToCart: (product: Product & { selectedVariants?: Record<string, string> }, quantity?: number) => void;
  removeFromCart: (productId: string, selectedVariants?: Record<string, string>) => void;
  updateQuantity: (productId: string, quantity: number, selectedVariants?: Record<string, string>) => void;
  clearCart: () => void;
  getCartTotal: () => number;
  getCartCount: () => number;

  // User (يبقى محلي للجلسة الحالية)
  user: User | null;
  setUser: (user: User | null) => void;
  isAdmin: () => boolean;

  // Products (من Firestore)
  products: Product[];
  setProducts: (products: Product[]) => void;

  // Store info / branding (من Firestore settings/store)
  storeInfo: StoreInfo;
  setStoreInfo: (info: Partial<StoreInfo>) => void;

  // الهوية النظامية للفواتير (من Firestore settings/store.business)
  businessInfo: BusinessInfo;
  setBusinessInfo: (info: Partial<BusinessInfo>) => void;

  // Wishlist (المفضلة)
  wishlist: string[];
  toggleWishlist: (productId: string) => void;
  isInWishlist: (productId: string) => boolean;
  clearWishlist: () => void;

  // UI
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
}

export const useStore = create<StoreState>()(
  persist(
    (set, get) => ({
      // Cart
      cart: [],
      addToCart: (product, quantity = 1) => {
        const cart = get().cart;
        const { selectedVariants, ...productData } = product;
        
        // دالة للمقارنة بين المتغيرات المختارة
        const variantsMatch = (v1?: Record<string, string>, v2?: Record<string, string>) => {
          if (!v1 && !v2) return true;
          if (!v1 || !v2) return false;
          const keys1 = Object.keys(v1);
          const keys2 = Object.keys(v2);
          if (keys1.length !== keys2.length) return false;
          return keys1.every(key => v1[key] === v2[key]);
        };
        
        const existing = cart.find(
          (item) => item.product.id === productData.id && variantsMatch(item.selectedVariants, selectedVariants)
        );

        if (existing) {
          set({
            cart: cart.map((item) =>
              item.product.id === productData.id && variantsMatch(item.selectedVariants, selectedVariants)
                ? { ...item, quantity: item.quantity + quantity }
                : item,
            ),
          });
        } else {
          set({ cart: [...cart, { product: productData as Product, quantity, selectedVariants }] });
        }
      },
      removeFromCart: (productId, selectedVariants) => {
        const variantsMatch = (v1?: Record<string, string>, v2?: Record<string, string>) => {
          if (!v1 && !v2) return true;
          if (!v1 || !v2) return false;
          const keys1 = Object.keys(v1);
          const keys2 = Object.keys(v2);
          if (keys1.length !== keys2.length) return false;
          return keys1.every(key => v1[key] === v2[key]);
        };
        
        set({
          cart: get().cart.filter(
            (item) => !(item.product.id === productId && variantsMatch(item.selectedVariants, selectedVariants))
          ),
        });
      },
      updateQuantity: (productId, quantity, selectedVariants) => {
        if (quantity <= 0) {
          get().removeFromCart(productId, selectedVariants);
          return;
        }
        
        const variantsMatch = (v1?: Record<string, string>, v2?: Record<string, string>) => {
          if (!v1 && !v2) return true;
          if (!v1 || !v2) return false;
          const keys1 = Object.keys(v1);
          const keys2 = Object.keys(v2);
          if (keys1.length !== keys2.length) return false;
          return keys1.every(key => v1[key] === v2[key]);
        };
        
        set({
          cart: get().cart.map((item) =>
            item.product.id === productId && variantsMatch(item.selectedVariants, selectedVariants)
              ? { ...item, quantity }
              : item,
          ),
        });
      },
      clearCart: () => set({ cart: [] }),
      getCartTotal: () => {
        return get().cart.reduce(
          (total, item) => total + item.product.price * item.quantity,
          0,
        );
      },
      getCartCount: () => {
        return get().cart.reduce((count, item) => count + item.quantity, 0);
      },

      // User
      user: null,
      setUser: (user) => set({ user }),
      isAdmin: () => get().user?.role === "admin",

      // Products
      products: [],
      setProducts: (products) => set({ products }),

      // Store info
      storeInfo: DEFAULT_STORE_INFO,
      setStoreInfo: (info) =>
        set((state) => ({ storeInfo: { ...state.storeInfo, ...info } })),

      // Business / legal identity
      businessInfo: DEFAULT_BUSINESS_INFO,
      setBusinessInfo: (info) =>
        set((state) => ({ businessInfo: { ...state.businessInfo, ...info } })),

      // Wishlist
      wishlist: [],
      toggleWishlist: (productId) => {
        const wishlist = get().wishlist;
        if (wishlist.includes(productId)) {
          set({ wishlist: wishlist.filter((id) => id !== productId) });
        } else {
          set({ wishlist: [...wishlist, productId] });
        }
      },
      isInWishlist: (productId) => get().wishlist.includes(productId),
      clearWishlist: () => set({ wishlist: [] }),

      // UI
      sidebarOpen: true,
      toggleSidebar: () => set({ sidebarOpen: !get().sidebarOpen }),
      setSidebarOpen: (open) => set({ sidebarOpen: open }),
      searchQuery: "",
      setSearchQuery: (query) => set({ searchQuery: query }),
    }),
    {
      name: "estore",
      partialize: (state) => ({ cart: state.cart, wishlist: state.wishlist }),
    },
  ),
);
