// Каталог «Звёздных подарков» и пул коллекционных (NFT) юзернеймов.
// Идеи и названия подсмотрены в исходниках Telegram (TL_starGift, Gifts/*).

// Каждый подарок: id, эмодзи-обложка, название, цена в звёздах,
// limited — ограниченный тираж (availability_remains/total),
// per_user_deal — сколько копий может купить один пользователь,
// convert — сколько звёзд получает одариваемый при получении подарка,
// upgrade — цена превращения копии в «уникальный» NFT-подарок.
const STAR_GIFTS = [
  { id: 'g1', emoji: '❤️',  name: 'Сердце',          price: 100, per_user_deal: 0 },
  { id: 'g2', emoji: '⭐',  name: 'Звезда',          price: 250, per_user_deal: 0 },
  { id: 'g3', emoji: '🔥',  name: 'Пламя',           price: 400, per_user_deal: 0 },
  { id: 'g4', emoji: '🌹',  name: 'Алая роза',       price: 350, per_user_deal: 0 },
  { id: 'g5', emoji: '🍫',  name: 'Трюфель',         price: 300, per_user_deal: 0 },
  { id: 'g6', emoji: '🚀',  name: 'Ракета',          price: 600, per_user_deal: 0 },
  { id: 'g7', emoji: '👾',  name: 'Инопланетянин',   price: 500, per_user_deal: 0 },
  { id: 'g8', emoji: '🎁',  name: 'Сюрприз',         price: 800, per_user_deal: 1 },
  { id: 'g9', emoji: '💎',  name: 'Алмаз',           price: 1200, limited: true, total: 50, per_user_deal: 1, upgrade: 2500 },
  { id: 'g10', emoji: '👑', name: 'Корона',          price: 2500, limited: true, total: 25, per_user_deal: 1, upgrade: 5000 },
  { id: 'g11', emoji: '🦄', name: 'Наргл-Единорог',  price: 4000, limited: true, total: 10, per_user_deal: 1, upgrade: 8000 },
  { id: 'g12', emoji: '🗿', name: 'Моаи',            price: 1, per_user_deal: 0, convert: 100 },
];

// Пул коллекционных юзернеймов «фрагмент-стиль». Каждый имеет стартовую цену и
// переходит в ротацию аукционов, изредка поднимая минимальную ставку.
const COLLECTIBLE_NAMES = [
  { username: 'x',     base: 1500,  buyNow: 6000 },
  { username: 'rock',  base: 600,   buyNow: 2500 },
  { username: 'moon',  base: 600,   buyNow: 2500 },
  { username: 'durov',  base: 30000, buyNow: 90000 },
  { username: 'zeta',  base: 500,   buyNow: 2000 },
  { username: 'nova',  base: 300,   buyNow: 1200 },
  { username: 'duck',  base: 200,   buyNow: 900 },
  { username: 'cyber', base: 400,   buyNow: 1500 },
  { username: 'anon',  base: 450,   buyNow: 1800 },
];

const SELL_FEE_PERCENT = 10;
const AUCTION_ROUND_SECONDS = 60 * 60 * 4; // стандартный срок аукциона
const AUCTION_TOP_ACCOUNTS = 3;            // сколько «слотов» выставляется на аукцион за раз
const AUCTION_STEP = 50;                   // минимальный шаг ставки

function giftById(id) {
  return STAR_GIFTS.find((g) => g.id === id) || null;
}

module.exports = { STAR_GIFTS, COLLECTIBLE_NAMES, SELL_FEE_PERCENT, AUCTION_ROUND_SECONDS, AUCTION_TOP_ACCOUNTS, AUCTION_STEP, giftById };