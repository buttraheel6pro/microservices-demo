// ─────────────────────────────────────────
// Event type constants for the saga
// ─────────────────────────────────────────

export const Events = {
  // Order events
  ORDER_CREATED: 'order.created',
  ORDER_COMPLETED: 'order.completed',
  ORDER_CANCELLED: 'order.cancelled',

  // Inventory events
  INVENTORY_RESERVED: 'inventory.reserved',
  INVENTORY_RELEASED: 'inventory.released',
  INVENTORY_FAILED: 'inventory.failed',

  // Payment events
  PAYMENT_SUCCESS: 'payment.success',
  PAYMENT_FAILED: 'payment.failed',
} as const;

export type EventType = (typeof Events)[keyof typeof Events];

// ─────────────────────────────────────────
// Event payload interfaces
// ─────────────────────────────────────────

export interface OrderCreatedPayload {
  orderId: string;
  productId: string;
  quantity: number;
  amount: number;
}

export interface OrderCompletedPayload {
  orderId: string;
}

export interface OrderCancelledPayload {
  orderId: string;
  reason: string;
}

export interface InventoryReservedPayload {
  orderId: string;
  productId: string;
  quantity: number;
  amount: number;
}

export interface InventoryReleasedPayload {
  orderId: string;
  productId: string;
  quantity: number;
}

export interface InventoryFailedPayload {
  orderId: string;
  productId: string;
  reason: string;
}

export interface PaymentSuccessPayload {
  orderId: string;
  paymentId: string;
  amount: number;
}

export interface PaymentFailedPayload {
  orderId: string;
  paymentId: string;
  amount: number;
  reason: string;
}

export interface BaseEvent<T = unknown> {
  eventType: EventType;
  timestamp: string;
  payload: T;
}
