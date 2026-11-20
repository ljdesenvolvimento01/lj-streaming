
// ======================================================
// LJ STREAMING - BACKEND COMPLETO
// API + PLAYER + LOGIN + CADASTRO + ADMIN + RECUPERACAO
// + ASSINATURA LJ PREMIUM / MERCADO PAGO
// ======================================================

require("dotenv").config();

const express = require("express");
const axios = require("axios");
const { pool } = require("./db");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const nodemailer = require("nodemailer");

const rateLimitModule = require("express-rate-limit");
const rateLimit = rateLimitModule.rateLimit || rateLimitModule;

const app = express();
app.disable("x-powered-by");

// ======================================================
// CONFIGURACOES
// ======================================================

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "../public");
const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");

const API_URL = process.env.API_BASE_URL;
const API_USERNAME = process.env.API_USERNAME;
const API_PASSWORD = process.env.API_PASSWORD;

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;

let emailTransporter = null;
let cachedStreamOrigin = null;

if (!API_URL || !API_USERNAME || !API_PASSWORD) {
    console.error("ERRO: Configure as credenciais da API no .env.");
    process.exit(1);
}

if (!ADMIN_PASSWORD || !SESSION_SECRET || SESSION_SECRET.length < 32) {
    console.error("ERRO: Configure ADMIN_PASSWORD e SESSION_SECRET no .env.");
    process.exit(1);
}

try {
    new URL(API_URL);
    new URL(APP_BASE_URL);
} catch {
    console.error("ERRO: API_BASE_URL e APP_BASE_URL precisam ser URLs válidas.");
    process.exit(1);
}

if (IS_PRODUCTION) {
    app.set("trust proxy", 1);
}

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

// ======================================================
// MIDDLEWARES GERAIS
// ======================================================

app.use(express.json({ limit: "20kb" }));
app.use(express.urlencoded({ extended: false, limit: "20kb" }));

app.use(session({
    name: "lj_streaming_session",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
        httpOnly: true,
        secure: IS_PRODUCTION,
        sameSite: "lax",
        maxAge: 8 * 60 * 60 * 1000
    }
}));

if (IS_PRODUCTION) {
    console.warn("AVISO: configure armazenamento persistente de sessões antes de publicar.");
}

// ======================================================
// BANCO DE USUARIOS
// ======================================================
// ======================================================
// POSTGRESQL - USUARIOS
// ======================================================

function mapearUsuario(row) {
    if (!row) return null;

    const dados = row.data || {};

    return {
        ...dados,
        id: row.id,
        username: row.username,
        email: row.email || "",
        passwordHash: row.password_hash,
        role: row.role,
        active: row.active,
        authVersion: row.auth_version,
        createdAt: row.created_at,
        plan: row.plan,
        subscriptionStatus: row.subscription_status || "inactive",
        subscriptionExpiresAt: row.subscription_expires_at
    };
}

async function buscarUsuarioPorId(id) {
    const resultado = await pool.query(
        "SELECT * FROM users WHERE id = $1 LIMIT 1",
        [id]
    );

    return mapearUsuario(resultado.rows[0]);
}

async function buscarUsuarioPorUsername(username) {
    const resultado = await pool.query(
        "SELECT * FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1",
        [username]
    );

    return mapearUsuario(resultado.rows[0]);
}

async function listarUsuariosPostgres() {
    const resultado = await pool.query(
        "SELECT * FROM users ORDER BY created_at DESC"
    );

    return resultado.rows.map(mapearUsuario);
}
// ======================================================
// PRESERVAR DADOS EXTRAS DO USUARIO NO POSTGRESQL
// ======================================================

function dadosExtrasUsuario(usuario) {
    const camposDoBanco = new Set([
        "id",
        "username",
        "email",
        "passwordHash",
        "role",
        "active",
        "authVersion",
        "createdAt",
        "plan",
        "subscriptionStatus",
        "subscriptionExpiresAt",
        "data"
    ]);

    const dados = { ...(usuario.data || {}) };

    for (const [chave, valor] of Object.entries(usuario)) {
        if (!camposDoBanco.has(chave)) {
            dados[chave] = valor;
        }
    }

    return dados;
}   

async function salvarUsuarioPostgres(usuario) {
    await pool.query(
        `INSERT INTO users (
            id, username, email, password_hash, role,
            active, auth_version, plan, subscription_status,
            subscription_expires_at, data
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (id) DO UPDATE SET
            username = EXCLUDED.username,
            email = EXCLUDED.email,
            password_hash = EXCLUDED.password_hash,
            role = EXCLUDED.role,
            active = EXCLUDED.active,
            auth_version = EXCLUDED.auth_version,
            plan = EXCLUDED.plan,
            subscription_status = EXCLUDED.subscription_status,
            subscription_expires_at = EXCLUDED.subscription_expires_at,
            data = EXCLUDED.data,
            updated_at = NOW()`,
        [
            usuario.id,
            usuario.username,
            usuario.email || null,
            usuario.passwordHash,
            usuario.role || "user",
            usuario.active !== false,
            Number(usuario.authVersion || 0),
            usuario.plan || null,
            usuario.subscriptionStatus || "inactive",
            usuario.subscriptionExpiresAt || null,
            JSON.stringify(dadosExtrasUsuario(usuario))
        ]
    );
}

function lerUsuarios() {
    try {
        if (!fs.existsSync(USERS_FILE)) return [];

        const dados = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));

        if (!Array.isArray(dados)) {
            throw new Error("Formato inválido do banco de usuários.");
        }

        return dados;
    } catch (error) {
        console.error("Erro ao ler usuários:", error.message);
        throw new Error("Não foi possível ler o banco de usuários.");
    }
}

function salvarUsuarios(usuarios) {
    const temporario = USERS_FILE + ".tmp";
    const backup = USERS_FILE + ".bak";

    fs.writeFileSync(temporario, JSON.stringify(usuarios, null, 2), {
        encoding: "utf8",
        mode: 0o600
    });

    let backupCriado = false;

    try {
        if (fs.existsSync(USERS_FILE)) {
            fs.rmSync(backup, { force: true });
            fs.renameSync(USERS_FILE, backup);
            backupCriado = true;
        }

        fs.renameSync(temporario, USERS_FILE);

        if (backupCriado) fs.rmSync(backup, { force: true });
    } catch (error) {
        if (backupCriado && !fs.existsSync(USERS_FILE) && fs.existsSync(backup)) {
            fs.renameSync(backup, USERS_FILE);
        }

        if (fs.existsSync(temporario)) {
            fs.rmSync(temporario, { force: true });
        }

        throw error;
    }
}

function emailValido(email) {
    return (
        typeof email === "string" &&
        email.length <= 254 &&
        /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)
    );
}

function usuarioPublico(usuario) {
    return {
        id: usuario.id,
        username: usuario.username,
        email: usuario.email || "",
        role: usuario.role,
        active: Boolean(usuario.active),
        createdAt: usuario.createdAt,
        plan: usuario.plan || null,
        subscriptionStatus: usuario.subscriptionStatus || "inactive",
        subscriptionExpiresAt: usuario.subscriptionExpiresAt || null
    };
}

// ======================================================
// CRIAR ADMINISTRADOR INICIAL
// ======================================================


async function prepararAdministrador() {
    let admin = await buscarUsuarioPorId("admin");

    if (!admin) {
        const resultado = await pool.query(
            `SELECT * FROM users
             WHERE role = 'admin'
             ORDER BY created_at ASC
             LIMIT 1`
        );

        admin = mapearUsuario(resultado.rows[0]);
    }

    const colisao = await pool.query(
        `SELECT id FROM users
         WHERE LOWER(username) = LOWER($1)
         AND id <> $2
         LIMIT 1`,
        [ADMIN_USERNAME, admin?.id || "admin"]
    );

    if (colisao.rows.length > 0) {
        throw new Error("ADMIN_USERNAME já pertence a outro usuário.");
    }

    if (!admin) {
        if (!ADMIN_PASSWORD) {
            throw new Error("ADMIN_PASSWORD não configurada no .env.");
        }

        admin = {
            id: "admin",
            username: ADMIN_USERNAME,
            email: "",
            passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 12),
            role: "admin",
            active: true,
            authVersion: 0,
            createdAt: new Date().toISOString(),
            plan: "ADMIN",
            subscriptionStatus: "active",
            subscriptionExpiresAt: null
        };
    } else {
        admin.id = "admin";
        admin.username = ADMIN_USERNAME;
        admin.role = "admin";
        admin.active = true;
        admin.authVersion = Number(admin.authVersion || 0);
        admin.email = admin.email || "";
        admin.plan = "ADMIN";
        admin.subscriptionStatus = "active";
        admin.subscriptionExpiresAt = null;
    }

    await salvarUsuarioPostgres(admin);

    console.log("Administrador inicial configurado no PostgreSQL.");
}


// ======================================================
// CONFIGURACAO DE EMAIL
// ======================================================

function obterTransportadorEmail() {
    const host = process.env.SMTP_HOST;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    const from = process.env.SMTP_FROM;
    const port = Number(process.env.SMTP_PORT || 587);

    if (!host || !user || !pass || !from) {
        throw new Error("Configuração SMTP incompleta no .env.");
    }

    if (!emailTransporter) {
        emailTransporter = nodemailer.createTransport({
            host,
            port,
            secure: process.env.SMTP_SECURE === "true",
            auth: { user, pass }
        });
    }

    return emailTransporter;
}

function hashCodigo(codigo) {
    return crypto.createHash("sha256").update(codigo).digest("hex");
}

// ======================================================
// SESSOES E AUTENTICACAO
// ======================================================

function destruirSessao(req) {
    if (req.session) req.session.destroy(() => {});
}

async function localizarUsuarioSessao(req) {
    const id = req.session?.user?.id;

    if (!id) return null;

    const usuario = await buscarUsuarioPorId(id);

    if (!usuario || !usuario.active) return null;

    const versaoSessao = Number(req.session.user.version || 0);
    const versaoAtual = Number(usuario.authVersion || 0);

    if (versaoSessao !== versaoAtual) return null;

    return usuario;
}
// ======================================================
// VERIFICACAO DE ASSINATURA E ACESSO
// ======================================================

function assinaturaEstaAtiva(usuario) {
    if (!usuario) return false;

    if (usuario.role === "admin") return true;

    if (usuario.subscriptionStatus !== "active") return false;

    if (!usuario.subscriptionExpiresAt) return false;

    const expiracao = new Date(usuario.subscriptionExpiresAt).getTime();

    return Number.isFinite(expiracao) && expiracao > Date.now();
}

async function exigirAcessoConteudo(tipo, id, usuario) {
    if (!usuario) return false;

    return sistemaCatalogo.podeAcessar(
        usuario,
        tipo,
        String(id),
        assinaturaEstaAtiva(usuario)
    );
}

function responderAcessoNegado(res) {
    return res.status(403).json({
        erro: "Este conteúdo é Premium. Ative sua assinatura LJ PREMIUM para assistir.",
        codigo: "ASSINATURA_NECESSARIA"
    });
}

// ======================================================
// MIDDLEWARES DE AUTENTICACAO
// ======================================================

async function exigirAutenticacao(req, res, next) {
    try {
        const usuario = await localizarUsuarioSessao(req);

        if (!usuario) {
            destruirSessao(req);

            return res.status(401).json({
                erro: "Sessão inválida ou expirada. Faça login novamente."
            });
        }

        req.currentUser = usuario;
        next();
    } catch (error) {
        console.error("Erro ao verificar sessão:", error.message);

        return res.status(500).json({
            erro: "Erro ao verificar autenticação."
        });
    }
}
// ======================================================
// AUTORIZACAO DE ADMINISTRADOR
// ======================================================

function exigirAdministrador(req, res, next) {
    if (!req.currentUser) {
        return res.status(401).json({
            erro: "Usuário não autenticado."
        });
    }

    if (req.currentUser.role !== "admin") {
        return res.status(403).json({
            erro: "Acesso permitido somente ao administrador."
        });
    }

    next();
}

// ======================================================
// CONEXAO COM API EXTERNA
// ======================================================

const apiClient = axios.create({
    timeout: 20000,
    maxRedirects: 5,
    headers: {
        Accept: "application/json"
    }
});

async function consultarAPI(params = {}) {
    const response = await apiClient.get(API_URL, {
        params: {
            username: API_USERNAME,
            password: API_PASSWORD,
            ...params
        }
    });

    return response.data;
}

// ======================================================
// SISTEMA DE CATALOGO
// ======================================================

const criarSistemaCatalogo = require("./catalog-system");

const sistemaCatalogo = criarSistemaCatalogo({
    pool,
    consultarAPI,
    exigirAdministrador
});


// ======================================================
// SISTEMA DE PAGAMENTOS - POSTGRESQL
// ======================================================

const criarSistemaPagamentos = require("./payment-system");

const sistemaPagamentos = criarSistemaPagamentos({
    pool,
    localizarUsuarioSessao,
    appBaseUrl: APP_BASE_URL
});

// ======================================================
// AUTENTICACAO DE PAGINAS
// ======================================================

async function exigirLoginPagina(req, res, next) {
    try {
        const usuario = await localizarUsuarioSessao(req);

        if (!usuario) {
            destruirSessao(req);
            return res.redirect("/login.html");
        }

        req.currentUser = usuario;
        next();
    } catch (error) {
        console.error(error.message);
        return res.status(500).send("Erro ao verificar sessão.");
    }
}

function exigirAdminPagina(req, res, next) {
    if (req.currentUser?.role !== "admin") {
        return res.redirect("/");
    }

    next();
}

// ======================================================
// LIMITADORES DE TENTATIVAS
// ======================================================

const limiteCadastro = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { erro: "Muitas tentativas de cadastro. Aguarde alguns minutos." }
});

const limiteLogin = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { erro: "Muitas tentativas de login. Tente novamente mais tarde." }
});

const limiteRecuperacao = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { erro: "Muitas solicitações. Tente novamente mais tarde." }
});

const limiteRedefinicao = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { erro: "Muitas tentativas. Tente novamente mais tarde." }
});

// ======================================================
// LOGIN
// ======================================================


// ======================================================
// LOGIN
// ======================================================

app.post("/api/auth/login", limiteLogin, async (req, res) => {
    try {
        const username = String(req.body?.username || "").trim();
        const password = String(req.body?.password || "");

        if (!username || !password) {
            return res.status(400).json({ erro: "Informe usuário e senha." });
        }

        const usuario = await buscarUsuarioPorUsername(username);

        if (!usuario || !usuario.active) {
            return res.status(401).json({ erro: "Usuário ou senha inválidos." });
        }

        const senhaCorreta = await bcrypt.compare(password, usuario.passwordHash);

        if (!senhaCorreta) {
            return res.status(401).json({ erro: "Usuário ou senha inválidos." });
        }

        req.session.regenerate(error => {
            if (error) {
                console.error("Erro ao criar sessão:", error.message);
                return res.status(500).json({ erro: "Não foi possível iniciar a sessão." });
            }

            req.session.user = {
                id: usuario.id,
                version: Number(usuario.authVersion || 0)
            };

            req.session.cookie.maxAge = 8 * 60 * 60 * 1000;

            req.session.save(saveError => {
                if (saveError) {
                    console.error("Erro ao salvar sessão:", saveError.message);
                    return res.status(500).json({ erro: "Não foi possível salvar a sessão." });
                }

                res.json({
                    sucesso: true,
                    user: usuarioPublico(usuario)
                });
            });
        });
    } catch (error) {
        console.error("Erro no login:", error.message);
        res.status(500).json({ erro: "Erro interno ao realizar login." });
    }
});

// ======================================================
// CADASTRO PUBLICO
// ======================================================

app.post("/api/auth/register", limiteCadastro, async (req, res) => {
    try {
        if (String(process.env.ALLOW_REGISTRATION).toLowerCase() !== "true") {
            return res.status(403).json({ erro: "Cadastro temporariamente fechado." });
        }

        const username = String(req.body?.username || "").trim();
        const email = String(req.body?.email || "").trim().toLowerCase();
        const password = String(req.body?.password || "");
        const confirmPassword = String(req.body?.confirmPassword || "");

        if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
            return res.status(400).json({ erro: "O usuário deve ter de 3 a 32 caracteres." });
        }

        if (!emailValido(email)) {
            return res.status(400).json({ erro: "Informe um e-mail válido." });
        }

        if (password.length < 8 || password.length > 128) {
            return res.status(400).json({ erro: "A senha deve ter de 8 a 128 caracteres." });
        }

        if (password !== confirmPassword) {
            return res.status(400).json({ erro: "As senhas não coincidem." });
        }

        const existente = await pool.query(
            `SELECT id FROM users
             WHERE LOWER(username) = LOWER($1)
                OR LOWER(email) = LOWER($2)
             LIMIT 1`,
            [username, email]
        );

        if (existente.rows.length > 0) {
            return res.status(409).json({ erro: "Usuário ou e-mail já cadastrado." });
        }

        const novoUsuario = {
            id: crypto.randomUUID(),
            username,
            email,
            passwordHash: await bcrypt.hash(password, 12),
            role: "user",
            active: true,
            authVersion: 0,
            createdAt: new Date().toISOString(),
            plan: null,
            subscriptionStatus: "inactive",
            subscriptionExpiresAt: null
        };

        await salvarUsuarioPostgres(novoUsuario);

        req.session.regenerate(error => {
            if (error) {
                console.error(error.message);
                return res.status(201).json({
                    sucesso: true,
                    mensagem: "Conta criada. Faça login para continuar."
                });
            }

            req.session.user = {
                id: novoUsuario.id,
                version: 0
            };

            req.session.cookie.maxAge = 8 * 60 * 60 * 1000;

            req.session.save(saveError => {
                if (saveError) {
                    console.error(saveError.message);
                    return res.status(201).json({
                        sucesso: true,
                        mensagem: "Conta criada. Faça login para continuar."
                    });
                }

                res.status(201).json({
                    sucesso: true,
                    user: usuarioPublico(novoUsuario)
                });
            });
        });
    } catch (error) {
        if (error.code === "23505") {
            return res.status(409).json({
                erro: "Usuário ou e-mail já cadastrado."
            });
        }

        console.error("Erro no cadastro:", error.message);
        res.status(500).json({ erro: "Não foi possível criar sua conta." });
    }
});

// ======================================================
// RECUPERACAO DE SENHA POR EMAIL
// ======================================================


// ======================================================
// RECUPERACAO DE SENHA POR EMAIL - POSTGRESQL
// ======================================================

app.post("/api/auth/forgot-password", limiteRecuperacao, async (req, res) => {
    const respostaPadrao = {
        sucesso: true,
        mensagem: "Se existir uma conta ativa com esse e-mail, enviaremos um código de recuperação."
    };

    try {
        const email = String(req.body?.email || "").trim().toLowerCase();

        if (!emailValido(email)) return res.json(respostaPadrao);

        const resultado = await pool.query(
            `SELECT * FROM users
             WHERE LOWER(email) = LOWER($1)
             AND active = TRUE
             LIMIT 1`,
            [email]
        );

        const usuario = mapearUsuario(resultado.rows[0]);

        if (!usuario) return res.json(respostaPadrao);

        const codigo = String(crypto.randomInt(100000, 1000000));

        usuario.resetCodeHash = hashCodigo(codigo);
        usuario.resetCodeExpiresAt = Date.now() + 15 * 60 * 1000;
        usuario.resetAttempts = 0;

        await salvarUsuarioPostgres(usuario);

        const transporter = obterTransportadorEmail();

        const resetUrl = new URL("/reset-password.html", APP_BASE_URL);
        resetUrl.searchParams.set("email", email);

        try {
            await transporter.sendMail({
                from: process.env.SMTP_FROM,
                to: email,
                subject: "Recuperação de senha - LJ Streaming",
                text: `
Olá, ${usuario.username}!

Seu código de recuperação é: ${codigo}

Ele expira em 15 minutos e só pode ser usado uma vez.

Acesse: ${resetUrl.href}

Se você não solicitou esta recuperação, ignore esta mensagem.
                `,
                html: `
<div style="font-family:Arial,sans-serif;background:#080b14;color:#fff;padding:30px;border-radius:12px">
    <h1 style="color:#a98cff">LJ STREAMING</h1>
    <h2>Recuperação de senha</h2>
    <p>Olá, ${usuario.username}!</p>
    <p>Seu código de verificação é:</p>
    <div style="font-size:32px;font-weight:bold;letter-spacing:8px;background:#202a3c;padding:20px;text-align:center;border-radius:8px">${codigo}</div>
    <p>Este código expira em <strong>15 minutos</strong>.</p>
    <a href="${resetUrl.href}" style="display:inline-block;background:#8655ff;color:white;text-decoration:none;padding:14px 22px;border-radius:7px">Redefinir senha</a>
    <p style="color:#929db3;font-size:12px">Se você não solicitou esta recuperação, ignore esta mensagem.</p>
</div>
                `
            });
        } catch (mailError) {
            delete usuario.resetCodeHash;
            delete usuario.resetCodeExpiresAt;
            delete usuario.resetAttempts;

            await salvarUsuarioPostgres(usuario);

            console.error("Erro ao enviar e-mail:", mailError.message);

            return res.status(502).json({
                erro: "Não foi possível enviar o e-mail. Confira as configurações SMTP."
            });
        }

        res.json(respostaPadrao);

    } catch (error) {
        console.error("Erro na recuperação:", error.message);

        res.status(503).json({
            erro: "Serviço de recuperação temporariamente indisponível."
        });
    }
});

// ======================================================
// REDEFINIR SENHA - POSTGRESQL
// ======================================================

app.post("/api/auth/reset-password", limiteRedefinicao, async (req, res) => {
    try {
        const email = String(req.body?.email || "").trim().toLowerCase();
        const codigo = String(req.body?.code || "").trim();
        const password = String(req.body?.password || "");

        if (!emailValido(email)) {
            return res.status(400).json({ erro: "Dados de recuperação inválidos." });
        }

        if (!/^\d{6}$/.test(codigo)) {
            return res.status(400).json({ erro: "Informe o código de seis dígitos." });
        }

        if (password.length < 8 || password.length > 128) {
            return res.status(400).json({ erro: "A nova senha deve ter de 8 a 128 caracteres." });
        }

        const resultado = await pool.query(
            `SELECT * FROM users
             WHERE LOWER(email) = LOWER($1)
             AND active = TRUE
             LIMIT 1`,
            [email]
        );

        const usuario = mapearUsuario(resultado.rows[0]);

        if (!usuario || !usuario.resetCodeHash) {
            return res.status(400).json({ erro: "Código inválido ou expirado." });
        }

        const expirado = Date.now() > Number(usuario.resetCodeExpiresAt || 0);
        const tentativas = Number(usuario.resetAttempts || 0);

        if (expirado || tentativas >= 5) {
            delete usuario.resetCodeHash;
            delete usuario.resetCodeExpiresAt;
            delete usuario.resetAttempts;

            await salvarUsuarioPostgres(usuario);

            return res.status(400).json({
                erro: "Código inválido ou expirado. Solicite outro."
            });
        }

        const recebido = Buffer.from(hashCodigo(codigo), "hex");
        const armazenado = Buffer.from(usuario.resetCodeHash, "hex");

        const correto =
            recebido.length === armazenado.length &&
            crypto.timingSafeEqual(recebido, armazenado);

        if (!correto) {
            usuario.resetAttempts = tentativas + 1;

            if (usuario.resetAttempts >= 5) {
                delete usuario.resetCodeHash;
                delete usuario.resetCodeExpiresAt;
                delete usuario.resetAttempts;
            }

            await salvarUsuarioPostgres(usuario);

            return res.status(400).json({
                erro: "Código inválido ou expirado."
            });
        }

        usuario.passwordHash = await bcrypt.hash(password, 12);
        usuario.authVersion = Number(usuario.authVersion || 0) + 1;

        delete usuario.resetCodeHash;
        delete usuario.resetCodeExpiresAt;
        delete usuario.resetAttempts;

        await salvarUsuarioPostgres(usuario);

        res.json({
            sucesso: true,
            mensagem: "Senha redefinida com sucesso. Faça login novamente."
        });

    } catch (error) {
        console.error("Erro ao redefinir senha:", error.message);
        res.status(500).json({
            erro: "Não foi possível redefinir sua senha."
        });
    }
});

// ======================================================
// STATUS PUBLICO
// ======================================================
// Verificação pública de saúde da API
app.get("/api/health", (req, res) => {
    res.status(200).json({
        servidor: "LJ Streaming",
        status: "online"
    });
});


app.get("/api/status", (req, res) => {
    res.json({
        servidor: "LJ Streaming",
        status: "online"
    });
});

// ======================================================
// WEBHOOK PUBLICO E PROTECAO DAS ROTAS
// ======================================================

// Webhook do Mercado Pago: não exige login.
app.use("/api/payments", sistemaPagamentos.webhookRouter);

// Todas as demais rotas /api exigem login.
app.use("/api", exigirAutenticacao);

// Catálogo protegido: req.currentUser já está disponível.
app.use("/api", sistemaCatalogo.router);

// Pagamentos exigem login, mas não assinatura ativa.
app.use("/api", sistemaPagamentos.router);

// ======================================================
// SESSAO ATUAL
// ======================================================

app.get("/api/auth/me", (req, res) => {
    res.json({
        autenticado: true,
        user: usuarioPublico(req.currentUser)
    });
});

// ======================================================
// LOGOUT
// ======================================================

app.post("/api/auth/logout", (req, res) => {
    req.session.destroy(error => {
        if (error) {
            console.error("Erro ao sair:", error.message);
            return res.status(500).json({ erro: "Não foi possível encerrar a sessão." });
        }

        res.clearCookie("lj_streaming_session", {
            httpOnly: true,
            secure: IS_PRODUCTION,
            sameSite: "lax"
        });

        res.json({ sucesso: true, mensagem: "Sessão encerrada." });
    });
});


// ======================================================
// ADMINISTRACAO DE USUARIOS - POSTGRESQL
// ======================================================

// LISTAR USUARIOS
app.get("/api/admin/users", exigirAdministrador, async (req, res) => {
    try {
        const usuarios = await listarUsuariosPostgres();

        res.json(usuarios.map(usuarioPublico));
    } catch (error) {
        console.error("Erro ao listar usuários:", error.message);
        res.status(500).json({
            erro: "Não foi possível listar os usuários."
        });
    }
});

// CRIAR USUARIO
app.post("/api/admin/users", exigirAdministrador, async (req, res) => {
    try {
        const username = String(req.body?.username || "").trim();
        const email = String(req.body?.email || "").trim().toLowerCase();
        const password = String(req.body?.password || "");

        if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
            return res.status(400).json({
                erro: "Nome de usuário inválido."
            });
        }

        if (email && !emailValido(email)) {
            return res.status(400).json({
                erro: "Informe um e-mail válido."
            });
        }

        if (password.length < 8 || password.length > 128) {
            return res.status(400).json({
                erro: "A senha deve ter de 8 a 128 caracteres."
            });
        }

        const duplicado = await pool.query(
            `SELECT id FROM users
             WHERE LOWER(username) = LOWER($1)
                OR ($2 <> '' AND LOWER(email) = LOWER($2))
             LIMIT 1`,
            [username, email]
        );

        if (duplicado.rows.length > 0) {
            return res.status(409).json({
                erro: "Usuário ou e-mail já cadastrado."
            });
        }

        const novoUsuario = {
            id: crypto.randomUUID(),
            username,
            email,
            passwordHash: await bcrypt.hash(password, 12),
            role: "user",
            active: true,
            authVersion: 0,
            createdAt: new Date().toISOString(),
            plan: null,
            subscriptionStatus: "inactive",
            subscriptionExpiresAt: null
        };

        await salvarUsuarioPostgres(novoUsuario);

        res.status(201).json({
            sucesso: true,
            user: usuarioPublico(novoUsuario)
        });

    } catch (error) {
        if (error.code === "23505") {
            return res.status(409).json({
                erro: "Usuário ou e-mail já cadastrado."
            });
        }

        console.error("Erro ao criar usuário:", error.message);

        res.status(500).json({
            erro: "Não foi possível criar o usuário."
        });
    }
});

// BLOQUEAR / DESBLOQUEAR USUARIO
app.patch("/api/admin/users/:id", exigirAdministrador, async (req, res) => {
    try {
        const { id } = req.params;
        const { active } = req.body || {};

        if (typeof active !== "boolean") {
            return res.status(400).json({
                erro: "Informe active como verdadeiro ou falso."
            });
        }

        const usuario = await buscarUsuarioPorId(id);

        if (!usuario) {
            return res.status(404).json({
                erro: "Usuário não encontrado."
            });
        }

        if (usuario.role === "admin") {
            return res.status(403).json({
                erro: "Não é permitido bloquear o administrador."
            });
        }

        usuario.active = active;
        usuario.authVersion = Number(usuario.authVersion || 0) + 1;

        await salvarUsuarioPostgres(usuario);

        res.json({
            sucesso: true,
            mensagem: active ? "Usuário desbloqueado." : "Usuário bloqueado.",
            user: usuarioPublico(usuario)
        });

    } catch (error) {
        console.error("Erro ao atualizar usuário:", error.message);

        res.status(500).json({
            erro: "Não foi possível atualizar o usuário."
        });
    }
});

// ALTERAR EMAIL DE RECUPERACAO
app.patch("/api/admin/users/:id/email", exigirAdministrador, async (req, res) => {
    try {
        const { id } = req.params;
        const email = String(req.body?.email || "").trim().toLowerCase();

        if (!emailValido(email)) {
            return res.status(400).json({
                erro: "Informe um e-mail válido."
            });
        }

        const usuario = await buscarUsuarioPorId(id);

        if (!usuario) {
            return res.status(404).json({
                erro: "Usuário não encontrado."
            });
        }

        const duplicado = await pool.query(
            `SELECT id FROM users
             WHERE LOWER(email) = LOWER($1)
             AND id <> $2
             LIMIT 1`,
            [email, id]
        );

        if (duplicado.rows.length > 0) {
            return res.status(409).json({
                erro: "Este e-mail já pertence a outra conta."
            });
        }

        usuario.email = email;

        await salvarUsuarioPostgres(usuario);

        res.json({
            sucesso: true,
            mensagem: "E-mail atualizado.",
            user: usuarioPublico(usuario)
        });

    } catch (error) {
        console.error("Erro ao alterar e-mail:", error.message);

        res.status(500).json({
            erro: "Não foi possível atualizar o e-mail."
        });
    }
});

// EXCLUIR USUARIO
app.delete("/api/admin/users/:id", exigirAdministrador, async (req, res) => {
    try {
        const { id } = req.params;

        if (id === req.currentUser.id || id === "admin") {
            return res.status(403).json({
                erro: "Não é permitido excluir esta conta."
            });
        }

        const usuario = await buscarUsuarioPorId(id);

        if (!usuario) {
            return res.status(404).json({
                erro: "Usuário não encontrado."
            });
        }

        if (usuario.role === "admin") {
            return res.status(403).json({
                erro: "Não é permitido excluir administradores."
            });
        }

        await pool.query(
            "DELETE FROM users WHERE id = $1",
            [id]
        );

        res.json({
            sucesso: true,
            mensagem: "Usuário excluído."
        });

    } catch (error) {
        console.error("Erro ao excluir usuário:", error.message);

        res.status(500).json({
            erro: "Não foi possível excluir o usuário."
        });
    }
});

// ======================================================
// CACHE INTELIGENTE - CATALOGO DE FILMES
// Validade: 5 minutos
// ======================================================

const CACHE_FILMES_TTL = 5 * 60 * 1000;

const cacheFilmes = new Map();
const requisicoesFilmes = new Map();

async function consultarFilmesComCache(categoryId) {
    const chave = categoryId ? `categoria:${categoryId}` : "todos";
    const agora = Date.now();

    const cacheAtual = cacheFilmes.get(chave);

    if (cacheAtual && agora < cacheAtual.expiraEm) {
        console.log(`[LJ CACHE] Filmes encontrados: ${chave}`);
        return cacheAtual.dados;
    }

    if (requisicoesFilmes.has(chave)) {
        console.log(`[LJ CACHE] Consulta compartilhada: ${chave}`);
        return requisicoesFilmes.get(chave);
    }

    const requisicao = (async () => {
        try {
            console.log(`[LJ CACHE] Buscando na API externa: ${chave}`);

            const parametros = {
                action: "get_vod_streams",
                ...(categoryId ? { category_id: categoryId } : {})
            };

            const dados = await consultarAPI(parametros);

            cacheFilmes.set(chave, {
                dados,
                expiraEm: Date.now() + CACHE_FILMES_TTL
            });

            console.log(`[LJ CACHE] Cache atualizado: ${chave}`);

            return dados;
        } catch (error) {
            if (cacheAtual) {
                console.warn(
                    `[LJ CACHE] API indisponível. Utilizando cache anterior: ${chave}`
                );

                return cacheAtual.dados;
            }

            throw error;
        } finally {
            requisicoesFilmes.delete(chave);
        }
    })();

    requisicoesFilmes.set(chave, requisicao);

    return requisicao;
}


 // ======================================================
// TV AO VIVO
// ======================================================

app.get("/api/live/categories", async (req, res) => {
    try {
        const categorias = await consultarAPI({
            action: "get_live_categories"
        });

        res.json(categorias);

    } catch (error) {
        console.error(
            "Erro nas categorias de TV:",
            error.message
        );

        res.status(502).json({
            erro: "Erro ao carregar categorias de TV."
        });
    }
});

app.get("/api/live", async (req, res) => {
    try {
        const itens = await consultarAPI({
            action: "get_live_streams",
            ...(req.query.category_id ? {
                category_id: req.query.category_id
            } : {})
        });

        res.json(
            await sistemaCatalogo.adicionarClassificacao(
                "live",
                itens
            )
        );

    } catch (error) {
        console.error(
            "Erro ao carregar canais:",
            error.message
        );

        res.status(502).json({
            erro: "Erro ao carregar canais."
        });
    }
});


// ======================================================
// CATEGORIAS DE FILMES
// ======================================================

app.get("/api/movies/categories", async (req, res) => {
    try {
        const categorias = await consultarAPI({
            action: "get_vod_categories"
        });

        res.json(categorias);
    } catch (error) {
        console.error("Erro ao carregar categorias de filmes:", error.message);

        res.status(502).json({
            erro: "Erro ao carregar categorias de filmes."
        });
    }
});

// ======================================================
// FILMES
// ======================================================

app.get("/api/movies", async (req, res) => {
    const inicioTotal = Date.now();

    try {
        console.time("[LJ] Consulta de filmes");

        const itens = await consultarFilmesComCache(
            req.query.category_id
        );

        console.timeEnd("[LJ] Consulta de filmes");

        console.time("[LJ] Classificação - filmes");

        const resultado = await sistemaCatalogo.adicionarClassificacao(
            "movies",
            itens
        );

        console.timeEnd("[LJ] Classificação - filmes");

        console.log(
            "[LJ] Quantidade de filmes:",
            Array.isArray(itens) ? itens.length : 0
        );

        console.log(
            "[LJ] Tempo total:",
            Date.now() - inicioTotal,
            "ms"
        );

        res.json(resultado);
    } catch (error) {
        console.error("[LJ] Erro ao carregar filmes:", error.message);

        res.status(502).json({
            erro: "Erro ao carregar filmes."
        });
    }
});


// ======================================================
// DETALHES DOS FILMES
// ======================================================

app.get("/api/movies/:id", async (req, res) => {
    try {
        const id = String(req.params.id);

        if (!/^\d+$/.test(id)) {
            return res.status(400).json({
                erro: "ID do filme inválido."
            });
        }

        // Verifica se o usuário pode acessar o conteúdo.
        if (!await exigirAcessoConteudo("movies", id, req.currentUser)) {
            return responderAcessoNegado(res);
        }

        // Consulta os detalhes do filme na API externa.
        const dados = await consultarAPI({
            action: "get_vod_info",
            vod_id: id
        });

        if (!dados || (!dados.info && !dados.movie_data)) {
            return res.status(404).json({
                erro: "Detalhes do filme não encontrados."
            });
        }

        return res.json(dados);

    } catch (error) {
        console.error(
            "[LJ] Erro ao carregar detalhes do filme:",
            error.message
        );

        return res.status(502).json({
            erro: "Erro ao carregar detalhes do filme."
        });
    }
});


// ======================================================
// SERIES
// ======================================================

app.get("/api/series/categories", async (req, res) => {
    try {
        res.json(await consultarAPI({
            action: "get_series_categories"
        }));
    } catch (error) {
        console.error("Erro nas categorias de séries:", error.message);

        res.status(502).json({
            erro: "Erro ao carregar categorias de séries."
        });
    }
});

app.get("/api/series", async (req, res) => {
    try {
        const itens = await consultarAPI({
            action: "get_series",
            ...(req.query.category_id ? {
                category_id: req.query.category_id
            } : {})
        });

        res.json(await sistemaCatalogo.adicionarClassificacao("series", itens));
    } catch (error) {
        console.error("Erro ao carregar séries:", error.message);
        res.status(502).json({ erro: "Erro ao carregar séries." });
    }
});

app.get("/api/series/:id", async (req, res) => {
    try {
        const id = req.params.id;

        if (!/^\d+$/.test(id)) {
            return res.status(400).json({ erro: "ID inválido." });
        }

        if (!await exigirAcessoConteudo("series", id, req.currentUser)) {
            return responderAcessoNegado(res);
        }

        res.json(await consultarAPI({
            action: "get_series_info",
            series_id: id
        }));
    } catch (error) {
        console.error("Erro ao carregar episódios:", error.message);
        res.status(502).json({ erro: "Erro ao carregar episódios." });
    }
});

// ======================================================
// PLAYER E PROXY HLS
// ======================================================

async function obterStreamOrigin() {
    if (cachedStreamOrigin) return cachedStreamOrigin;

    const dados = await consultarAPI();
    const info = dados.server_info || {};
    console.log("[LJ PLAYER] Informações do servidor de mídia:", {
    url: info.url,
    protocolo: info.server_protocol,
    porta: info.port,
    portaHttps: info.https_port
});
    const apiOrigin = new URL(API_URL).origin;

    const protocolValue = String(
        info.server_protocol || new URL(API_URL).protocol.replace(":", "")
    ).replace(":", "").toLowerCase();

    const protocol = protocolValue === "https" ? "https" : "http";

    const host = String(info.url || new URL(apiOrigin).hostname)
        .replace(/^https?:\/\//i, "")
        .split("/")[0];

    const servidor = new URL(`${protocol}://${host}`);
    const porta = protocol === "https" ? info.https_port : info.port;

    if (!servidor.port && porta) {
        servidor.port = String(porta);
    }

    cachedStreamOrigin = servidor.origin;

    return cachedStreamOrigin;
}

function criarTokenMidia(targetUrl, contexto) {
    const payload = {
        url: targetUrl,
        userId: String(contexto.userId),
        sessionId: String(contexto.sessionId),
        tipo: contexto.tipo,
        id: String(contexto.id),
        exp: Math.floor(Date.now() / 1000) + 15 * 60
    };

    const conteudo = Buffer.from(JSON.stringify(payload)).toString("base64url");

    const assinatura = crypto
        .createHmac("sha256", SESSION_SECRET)
        .update(conteudo)
        .digest("base64url");

    return `${conteudo}.${assinatura}`;
}

async function verificarTokenMidia(token, req) {
    if (typeof token !== "string" || token.length > 12000) return null;

    const partes = token.split(".");
    if (partes.length !== 2) return null;

    const [conteudo, assinaturaRecebida] = partes;

    if (
        !/^[A-Za-z0-9_-]+$/.test(conteudo) ||
        !/^[A-Za-z0-9_-]+$/.test(assinaturaRecebida)
    ) {
        return null;
    }

    const assinaturaEsperada = crypto
        .createHmac("sha256", SESSION_SECRET)
        .update(conteudo)
        .digest();

    let assinaturaBuffer;

    try {
        assinaturaBuffer = Buffer.from(assinaturaRecebida, "base64url");
    } catch {
        return null;
    }

    if (
        assinaturaBuffer.length !== assinaturaEsperada.length ||
        !crypto.timingSafeEqual(assinaturaBuffer, assinaturaEsperada)
    ) {
        return null;
    }

    let payload;

    try {
        payload = JSON.parse(
            Buffer.from(conteudo, "base64url").toString("utf8")
        );
    } catch {
        return null;
    }

    if (
        !payload.url ||
        !payload.userId ||
        !payload.sessionId ||
        !payload.tipo ||
        !payload.id ||
        !Number.isFinite(payload.exp) ||
        payload.exp < Math.floor(Date.now() / 1000) ||
        String(payload.userId) !== String(req.currentUser.id) ||
        String(payload.sessionId) !== String(req.sessionID)
    ) {
        return null;
    }

    let target;

    try {
        target = new URL(payload.url);
    } catch {
        return null;
    }

    if (!["http:", "https:"].includes(target.protocol)) return null;

    if (!await exigirAcessoConteudo(payload.tipo, payload.id, req.currentUser)) {
        return null;
    }

    return {
        ...payload,
        targetUrl: target.href
    };
}

async function encaminharMidia(url, req, res, contexto) {
    const playlist = /\.m3u8(?:$|\?)/i.test(url);
    const headers = {};

    if (req.headers.range) {
        headers.Range = req.headers.range;
    }

    const response = await axios.get(url, {
        responseType: playlist ? "text" : "stream",
        headers,
        timeout: 45000,
        maxRedirects: 5,
        validateStatus: () => true
    });

  if (response.status >= 400) {
    console.error("[LJ PLAYER] API externa recusou:", {
        status: response.status,
        contentType: response.headers["content-type"],
        detalhe: typeof response.data === "string"
            ? response.data.slice(0, 300)
            : "Resposta não textual"
    });

    if (
        response.data &&
        typeof response.data.destroy === "function"
    ) {
        response.data.destroy();
    }

    return res.status(response.status).json({
        erro: "O servidor de mídia recusou a reprodução."
    });
}

    res.setHeader("Cache-Control", "no-store");

    if (playlist) {
        const playlistUrl = new URL(url);
        const linhas = String(response.data).split(/\r?\n/);

        function converterUri(uri) {
            if (/^(data:|skd:)/i.test(uri)) return uri;

            const target = new URL(uri, playlistUrl);

            if (!["http:", "https:"].includes(target.protocol)) {
                throw new Error("Protocolo de mídia não permitido.");
            }

            const token = criarTokenMidia(target.href, contexto);

            return `/api/hls-resource?u=${encodeURIComponent(token)}`;
        }

        const convertidas = linhas.map(linha => {
            const atual = linha.trim();

            if (!atual) return linha;

            if (!atual.startsWith("#")) {
                return converterUri(atual);
            }

            return linha.replace(/URI="([^"]+)"/g, (match, uri) =>
                `URI="${converterUri(uri)}"`
            );
        });

        res.setHeader(
            "Content-Type",
            "application/vnd.apple.mpegurl"
        );

        return res.send(convertidas.join("\n"));
    }

    res.status(response.status);

    [
        "content-type",
        "content-length",
        "content-range",
        "accept-ranges"
    ].forEach(header => {
        if (response.headers[header]) {
            res.setHeader(header, response.headers[header]);
        }
    });

    response.data.on("error", error => {
        console.error("Erro no fluxo de mídia:", error.message);

        if (!res.headersSent) {
            res.status(502).end();
        } else {
            res.destroy();
        }
    });

    res.on("close", () => {
        if (!res.writableEnded) {
            response.data.destroy();
        }
    });

    response.data.pipe(res);
}

// ======================================================
// REPRODUCAO DE CONTEUDO
// ======================================================

app.get("/api/play/:type/:id/:extension", async (req, res) => {
    try {
        const { type, id, extension } = req.params;

        const extensoes = {
            live: ["m3u8", "ts"],
            movie: ["mp4", "mkv", "avi", "mov", "ts", "flv", "wmv", "3gp"],
            series: ["mp4", "mkv", "avi", "mov", "ts", "flv", "wmv", "3gp",]
        };

        if (
            !extensoes[type] ||
            !/^\d+$/.test(id) ||
            !extensoes[type].includes(extension.toLowerCase())
        ) {
            return res.status(400).json({
                erro: "Endereço de reprodução inválido."
            });
        }

        const catalogType = type === "movie" ? "movies" : type;

        const catalogId = type === "series"
            ? String(req.query.series_id || "")
            : String(id);

        if (!/^\d+$/.test(catalogId)) {
            return res.status(400).json({
                erro: "Informe o ID da série para reproduzir o episódio."
            });
        }

        if (!await exigirAcessoConteudo(catalogType, catalogId, req.currentUser)) {
            return responderAcessoNegado(res);
        }

        const origin = await obterStreamOrigin();

        const username = encodeURIComponent(API_USERNAME);
        const password = encodeURIComponent(API_PASSWORD);

        const caminho = `/${type}/${username}/${password}/${id}.${extension}`;
        const url = new URL(caminho, origin).href;

        const contexto = {
            userId: req.currentUser.id,
            sessionId: req.sessionID,
            tipo: catalogType,
            id: catalogId
        };

        await encaminharMidia(url, req, res, contexto);
    } catch (error) {
        console.error("Erro no player:", error.message);

        if (!res.headersSent) {
            res.status(502).json({
                erro: "Não foi possível iniciar a reprodução."
            });
        }
    }
});

// ======================================================
// RECURSOS INTERNOS HLS
// ======================================================

app.get("/api/hls-resource", async (req, res) => {
    try {
        const contexto = await verificarTokenMidia(req.query.u, req);

        if (!contexto) {
            return res.status(403).send("Recurso expirado ou não autorizado.");
        }

        await encaminharMidia(
            contexto.targetUrl,
            req,
            res,
            contexto
        );
    } catch (error) {
        console.error("Erro no segmento HLS:", error.message);

        if (!res.headersSent) {
            res.status(502).send("Erro ao carregar mídia.");
        }
    }
});

// ======================================================
// PAGINAS DO SITE
// ======================================================


app.get("/login.html", async (req, res) => {
    try {
        const usuario = await localizarUsuarioSessao(req);

        if (usuario) {
            return res.redirect(
                usuario.role === "admin" ? "/admin.html" : "/"
            );
        }
    } catch (error) {
        console.error(
            "Erro ao verificar sessão na página de login:",
            error.message
        );
    }

    return res.sendFile(
        path.join(PUBLIC_DIR, "login.html")
    );
});

app.get(
    "/admin.html",
    exigirLoginPagina,
    exigirAdminPagina,
    (req, res) => {
        res.sendFile(path.join(PUBLIC_DIR, "admin.html"));
    }
);
// ======================================================
// ROTA PRINCIPAL
// ======================================================

app.get("/", async (req, res) => {
    try {
        const usuario = await localizarUsuarioSessao(req);

        if (!usuario) {
            return res.redirect("/login.html");
        }

        return res.sendFile(path.join(PUBLIC_DIR, "index.html"));

    } catch (error) {
        console.error("Erro ao abrir página inicial:", error.message);
        return res.redirect("/login.html");
    }
});

app.use(express.static(PUBLIC_DIR, { index: false }));

// ======================================================
// TRATAMENTO DE ERROS
// ======================================================

app.use((error, req, res, next) => {
    console.error("Erro não tratado:", error.message);

    if (res.headersSent) {
        return next(error);
    }

    res.status(500).json({
        erro: "Erro interno do servidor."
    });
});

app.use((req, res) => {
    res.status(404).json({
        erro: "Página ou recurso não encontrado."
    });
});

// ======================================================
// INICIALIZACAO
// ======================================================

async function iniciarServidor() {
    try {
        await prepararAdministrador();

        const servidor = app.listen(PORT, "0.0.0.0", () => {
            console.log("--------------------------------");
            console.log("       LJ STREAMING");
            console.log("--------------------------------");
            console.log(`Servidor: http://localhost:${PORT}`);
            console.log("Autenticação: ativada");
            console.log("Cadastro público:", process.env.ALLOW_REGISTRATION);
            console.log("Painel administrativo: ativado");
            console.log("Assinatura: LJ PREMIUM - R$ 10,00 / 30 dias");
            console.log("Backend iniciado com sucesso!");
        });

        servidor.on("error", error => {
            console.error("Erro no servidor:", error);
        });
    } catch (error) {
        console.error("Não foi possível iniciar o servidor:", error);
        process.exitCode = 1;
    }
}

iniciarServidor();
