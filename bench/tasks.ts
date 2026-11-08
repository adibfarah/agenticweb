/**
 * Benchmark tasks with ground truth taken from the demo sites' data (examples/sites/*.ts).
 * `expect` lists strings that must all appear in a correct answer (case-insensitive).
 */
export type LookupTask = { site: "restaurant" | "shop" | "docs"; id: string; question: string; expect: string[] };

export const lookupTasks: LookupTask[] = [
  { site: "restaurant", id: "sunday-close", question: "What time does Bella Cucina close on Sunday?", expect: ["21:00"] },
  { site: "restaurant", id: "cacio-price", question: "How much is the cacio e pepe?", expect: ["17"] },
  { site: "restaurant", id: "vegan-pizza", question: "Which pizza is vegan?", expect: ["Marinara"] },
  { site: "restaurant", id: "dogs", question: "Are dogs allowed?", expect: ["patio"] },
  { site: "restaurant", id: "cancel", question: "How much notice do I need to give to cancel a booking?", expect: ["4 hours"] },
  { site: "restaurant", id: "gluten-free", question: "How much extra is gluten-free pasta?", expect: ["$3"] },
  { site: "restaurant", id: "phone", question: "What is the restaurant's phone number?", expect: ["555-0100"] },
  { site: "restaurant", id: "private-room", question: "How many guests does the private dining room seat?", expect: ["30"] },
  { site: "shop", id: "tee-price", question: "How much is the Everyday Tee?", expect: ["28"] },
  { site: "shop", id: "sale-returns", question: "Can I return sale items, and within how many days?", expect: ["14 days"] },
  { site: "shop", id: "free-shipping", question: "What is the minimum order for free shipping?", expect: ["$75"] },
  { site: "shop", id: "chinos-price", question: "What does the Relaxed Chinos cost?", expect: ["79"] },
  { site: "docs", id: "sms-limit", question: "What is the SMS body character limit?", expect: ["480"] },
  { site: "docs", id: "pro-price", question: "How much is the Pro plan per month?", expect: ["$49"] },
  { site: "docs", id: "pro-rate", question: "What is the rate limit on the Pro plan?", expect: ["600"] },
  { site: "docs", id: "auth", question: "How do I send my API key?", expect: ["Authorization", "Bearer"] },
];

export const matches = (text: string, expect: string[]) => expect.every((e) => text.toLowerCase().includes(e.toLowerCase()));
