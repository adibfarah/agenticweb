import { esc, layout } from "./layout.ts";

/** Ground truth for the demo restaurant. The benchmark checks answers against this. */
export const restaurant = {
  name: "Bella Cucina",
  description: "Family Italian restaurant in Portland, OR. Dine-in, takeaway and catering.",
  phone: "+1-503-555-0100",
  email: "hello@bellacucina.example",
  address: "1234 SE Hawthorne Blvd, Portland, OR 97214",
  hours: [
    { days: "Monday", open: null, close: null },
    { days: "Tuesday", open: "17:00", close: "22:00" },
    { days: "Wednesday", open: "17:00", close: "22:00" },
    { days: "Thursday", open: "17:00", close: "22:00" },
    { days: "Friday", open: "17:00", close: "23:00" },
    { days: "Saturday", open: "12:00", close: "23:00" },
    { days: "Sunday", open: "12:00", close: "21:00" },
  ],
  menu: [
    { section: "Antipasti", name: "Bruschetta al pomodoro", price: 9, description: "Grilled bread, tomatoes, basil, garlic.", diet: ["vegan"], allergens: ["gluten"] },
    { section: "Antipasti", name: "Burrata", price: 14, description: "Burrata with roasted peppers and pesto.", diet: ["vegetarian"], allergens: ["dairy", "nuts"] },
    { section: "Antipasti", name: "Calamari fritti", price: 13, description: "Fried squid with lemon aioli.", diet: [], allergens: ["gluten", "egg", "molluscs"] },
    { section: "Pasta", name: "Tagliatelle al ragù", price: 19, description: "Slow-cooked beef and pork ragù.", diet: [], allergens: ["gluten", "dairy", "egg"] },
    { section: "Pasta", name: "Spaghetti aglio e olio", price: 15, description: "Garlic, chili, olive oil.", diet: ["vegan"], allergens: ["gluten"] },
    { section: "Pasta", name: "Cacio e pepe", price: 17, description: "Pecorino romano and black pepper.", diet: ["vegetarian"], allergens: ["gluten", "dairy"] },
    { section: "Pasta", name: "Linguine alle vongole", price: 24, description: "Clams, white wine, parsley.", diet: [], allergens: ["gluten", "molluscs"] },
    { section: "Pizza", name: "Margherita", price: 16, description: "Tomato, mozzarella, basil.", diet: ["vegetarian"], allergens: ["gluten", "dairy"] },
    { section: "Pizza", name: "Marinara", price: 13, description: "Tomato, garlic, oregano.", diet: ["vegan"], allergens: ["gluten"] },
    { section: "Pizza", name: "Diavola", price: 18, description: "Tomato, mozzarella, spicy salami.", diet: [], allergens: ["gluten", "dairy"] },
    { section: "Dolci", name: "Tiramisù", price: 9, description: "Mascarpone, espresso, cocoa.", diet: ["vegetarian"], allergens: ["dairy", "egg", "gluten"] },
    { section: "Dolci", name: "Sorbetto al limone", price: 7, description: "Lemon sorbet.", diet: ["vegan"], allergens: [] },
  ],
  faq: [
    { q: "Do you take reservations?", a: "Yes. Book online up to 30 days ahead for parties of 1 to 12. For larger groups, contact us about private dining." },
    { q: "Is there parking?", a: "Free street parking on Hawthorne and a paid lot on SE 35th Ave." },
    { q: "Do you have gluten-free options?", a: "Yes. Gluten-free pasta is available for any pasta dish for $3 extra." },
    { q: "Are dogs allowed?", a: "Dogs are welcome on our outdoor patio but not inside." },
    { q: "What is your cancellation policy?", a: "Please cancel at least 4 hours before your booking. Parties of 7 or more who do not show up may be charged $20 per person." },
  ],
};

const nav: Array<[string, string]> = [
  ["/", "Home"],
  ["/menu.html", "Menu"],
  ["/about.html", "About"],
  ["/faq.html", "FAQ"],
  ["/book.html", "Book a table"],
  ["/contact.html", "Contact"],
];

const footer = `<div class="footer-cols">
  <div><h4>Visit</h4><p>${restaurant.address}</p></div>
  <div><h4>Hours</h4><ul class="hours">${restaurant.hours
    .map((h) => `<li>${h.days}: ${h.open ? `${h.open}–${h.close}` : "Closed"}</li>`)
    .join("")}</ul></div>
  <div><h4>Contact</h4><p><a href="tel:${restaurant.phone}">${restaurant.phone}</a><br><a href="mailto:${restaurant.email}">${restaurant.email}</a></p></div>
</div>`;

const page = (title: string, body: string, description?: string) =>
  layout({ siteName: restaurant.name, title, description, nav, body, footer });

export function restaurantPages(): Record<string, string> {
  const sections = [...new Set(restaurant.menu.map((m) => m.section))];
  return {
    "/": page(
      "Home",
      `<section class="hero"><div class="hero-img" style="background-image:url(/static/hero.jpg)"></div>
       <h1>Bella Cucina</h1><p class="tagline">Handmade pasta and wood-fired pizza on Hawthorne since 2009.</p>
       <a class="btn" href="/book.html">Book a table</a> <a class="btn btn-alt" href="/menu.html">See the menu</a></section>
       <section><h2>Tonight's special</h2><p>Ask your server about our seasonal risotto.</p></section>
       <section class="testimonials"><blockquote>"Best cacio e pepe in Portland." — Portland Monthly</blockquote></section>`,
      restaurant.description,
    ),
    "/menu.html": page(
      "Menu",
      `<h1>Our Menu</h1><p>All pasta is made fresh daily. Gluten-free pasta +$3.</p>
       ${sections
         .map(
           (s) => `<section class="menu-section"><h2>${s}</h2><div class="menu-grid">${restaurant.menu
             .filter((m) => m.section === s)
             .map(
               (m) => `<div class="menu-item"><div class="menu-item-head"><span class="dish">${esc(m.name)}</span><span class="dots"></span><span class="price">$${m.price}</span></div>
               <p class="desc">${esc(m.description)}</p>
               <p class="tags">${m.diet.map((d) => `<span class="tag tag-${d}">${d}</span>`).join(" ")}${m.allergens.length ? ` <small>Contains: ${m.allergens.join(", ")}</small>` : ""}</p></div>`,
             )
             .join("")}</div></section>`,
         )
         .join("")}`,
      "Antipasti, fresh pasta, wood-fired pizza and desserts.",
    ),
    "/about.html": page(
      "About",
      `<h1>About us</h1><p>Bella Cucina was opened in 2009 by the Romano family, who brought recipes from Bologna to Portland.</p>
       <p>We source vegetables from farms in the Willamette Valley and make all our pasta in-house every morning.</p>
       <h2>Private dining</h2><p>Our upstairs room seats up to 30 guests. Contact us for private events and catering. <a href="/catering-menu.pdf">Download the catering menu (PDF)</a></p>`,
    ),
    "/faq.html": page(
      "FAQ",
      `<h1>Frequently asked questions</h1><div class="accordion">${restaurant.faq
        .map((f) => `<details><summary>${esc(f.q)}</summary><div class="answer"><p>${esc(f.a)}</p></div></details>`)
        .join("")}</div>`,
    ),
    "/book.html": page(
      "Book a table",
      `<h1>Book a table</h1><p>Reservations for 1 to 12 guests, up to 30 days ahead.</p>
       <form id="booking" action="/api/book" method="post" class="booking-form">
         <label>Date <input type="date" name="date" required></label>
         <label>Time <select name="time" required>${["17:00", "17:30", "18:00", "18:30", "19:00", "19:30", "20:00", "20:30", "21:00"]
           .map((t) => `<option>${t}</option>`)
           .join("")}</select></label>
         <label>Guests <input type="number" name="party_size" min="1" max="12" value="2" required></label>
         <label>Name <input type="text" name="name" required></label>
         <label>Email <input type="email" name="email" required></label>
         <label>Phone <input type="tel" name="phone"></label>
         <label>Notes <textarea name="notes" placeholder="Allergies, high chair, occasion…"></textarea></label>
         <button type="submit">Request booking</button>
       </form>`,
    ),
    "/contact.html": page(
      "Contact",
      `<h1>Contact</h1><p>Call us at ${restaurant.phone} or send a message.</p>
       <form action="/api/contact" method="post"><label>Name <input name="name" required></label>
       <label>Email <input type="email" name="email" required></label><label>Message <textarea name="message" required></textarea></label>
       <button>Send</button></form>
       <div class="map"><iframe src="about:blank" title="Map"></iframe></div>`,
    ),
    "/privacy": page("Privacy policy", `<h1>Privacy policy</h1><p>We only use your details to manage your booking. We never sell personal data.</p>`),
  };
}
