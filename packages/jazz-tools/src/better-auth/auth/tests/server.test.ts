import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { OAuth2Server } from "oauth2-mock-server";
import { jazzPlugin } from "../server.js";
import { emailOTP, genericOAuth } from "better-auth/plugins";

describe("Better-Auth server plugin", async () => {
  describe("Email & Password", () => {
    let auth: ReturnType<typeof createAuth>;

    let accountCreationSpy: Mock;

    const createAuth = () =>
      betterAuth({
        database: memoryAdapter({
          user: [],
          session: [],
          verification: [],
          account: [],
        }),
        plugins: [jazzPlugin()],
        emailAndPassword: {
          enabled: true,
          requireEmailVerification: false, // Disable for testing
        },
        databaseHooks: {
          user: {
            create: {
              after: accountCreationSpy,
            },
          },
        },
      });

    beforeEach(() => {
      accountCreationSpy = vi.fn();

      // Create auth instance with in-memory database
      auth = createAuth();
    });

    it("should successfully register a new user with email and password", async () => {
      const userData = {
        name: "test",
        email: "test@example.com",
        password: "securePassword123",
      };

      const jazzAuth = {
        accountID: "123",
        secretSeed: [1, 2, 3],
        accountSecret: "123",
        provider: "better-auth",
      };

      const result = await auth.api.signUpEmail({
        body: userData,
        headers: {
          "x-jazz-auth": JSON.stringify(jazzAuth),
        },
      });

      expect(result).toBeDefined();
      expect(result).toMatchObject({
        user: {
          id: expect.any(String),
          email: userData.email,
          name: userData.name,
          image: undefined,
          emailVerified: false,
          createdAt: expect.any(Date),
          updatedAt: expect.any(Date),
        },
        jazzAuth: jazzAuth,
      });

      const res = await (await auth.$context).adapter.findOne({
        model: "user",
        where: [
          {
            field: "id",
            value: result.user.id,
          },
        ],
      });

      expect(res).toMatchObject({
        id: result.user.id,
        accountID: "123",
        encryptedCredentials: expect.any(String),
      });
    });

    it("should fail to register user without account ID", async () => {
      const userData = {
        name: "test",
        email: "email@email.it",
        password: "securePassword123",
      };

      await expect(
        auth.api.signUpEmail({
          body: userData,
        }),
      ).rejects.toThrow("JazzAuth is required");

      expect(accountCreationSpy).toHaveBeenCalledTimes(0);
    });

    it("should have AccountID in the registration hook", async () => {
      const userData = {
        name: "test",
        email: "email@email.it",
        password: "securePassword123",
      };

      const jazzAuth = {
        accountID: "123",
        secretSeed: [1, 2, 3],
        accountSecret: "123",
        provider: "better-auth",
      };

      await auth.api.signUpEmail({
        body: userData,
        headers: {
          "x-jazz-auth": JSON.stringify(jazzAuth),
        },
      });

      expect(accountCreationSpy).toHaveBeenCalledTimes(1);
      expect(accountCreationSpy).toHaveBeenCalledWith(
        // user
        expect.objectContaining({ accountID: "123" }),
        // context
        expect.any(Object),
      );
    });

    it("should successfully login a new user with email and password", async () => {
      const userData = {
        name: "test",
        email: "test@example.com",
        password: "securePassword123",
      };

      const jazzAuth = {
        accountID: "123",
        secretSeed: [1, 2, 3],
        accountSecret: "123",
        provider: "better-auth",
      };

      await auth.api.signUpEmail({
        body: userData,
        headers: {
          "x-jazz-auth": JSON.stringify(jazzAuth),
        },
      });

      const result = await auth.api.signInEmail({
        body: {
          email: userData.email,
          password: userData.password,
        },
      });

      expect(result).toBeDefined();
      expect(result).toMatchObject({
        user: {
          id: expect.any(String),
          email: userData.email,
          name: userData.name,
          image: undefined,
          emailVerified: false,
          createdAt: expect.any(Date),
          updatedAt: expect.any(Date),
        },
        jazzAuth: jazzAuth,
      });
    });
  });

  describe("OAuth/Social plugin", async () => {
    const providerId = "test";
    const clientId = "test-client-id";
    const clientSecret = "test-client-secret";
    const server = new OAuth2Server();
    await server.start();
    const oauthPort = Number(server.issuer.url?.split(":")[2]!);

    let auth: ReturnType<typeof createAuth>;
    let accountCreationSpy: Mock;
    let verificationCreationSpy: Mock;

    beforeAll(async () => {
      await server.issuer.keys.generate("RS256");

      server.service.on("beforeUserinfo", (userInfoResponse) => {
        userInfoResponse.body = {
          email: "oauth2@test.com",
          name: "OAuth2 Test",
          sub: "johndoe",
          picture: "https://test.com/picture.png",
          email_verified: true,
        };
        userInfoResponse.statusCode = 200;
      });
    });

    afterAll(async () => {
      await server.stop();
    });

    const createAuth = () =>
      betterAuth({
        database: memoryAdapter({
          user: [],
          session: [],
          verification: [],
          account: [],
        }),
        baseURL: "http://localhost:3000",
        plugins: [
          jazzPlugin(),
          genericOAuth({
            config: [
              {
                providerId,
                discoveryUrl: `http://localhost:${oauthPort}/.well-known/openid-configuration`,
                authorizationUrl: `http://localhost:${oauthPort}/authorize`,
                clientId: clientId,
                clientSecret: clientSecret,
                pkce: true,
              },
            ],
          }),
        ],
        socialProviders: {
          github: {
            clientId: "123",
            clientSecret: "123",
          },
        },
        databaseHooks: {
          user: {
            create: {
              after: accountCreationSpy,
            },
          },
          verification: {
            create: {
              after: verificationCreationSpy,
            },
          },
        },
      });

    beforeEach(() => {
      accountCreationSpy = vi.fn();
      verificationCreationSpy = vi.fn();

      // Create auth instance with in-memory database
      auth = createAuth();
    });

    it("should store jazzAuth in verification table when using social provider", async () => {
      await auth.api.signInSocial({
        body: {
          provider: "github",
          callbackURL: "http://localhost:3000/api/auth/sign-in/social/callback",
        },
        headers: {
          "x-jazz-auth": JSON.stringify({
            accountID: "123",
            secretSeed: [1, 2, 3],
            accountSecret: "123",
          }),
        },
      });

      expect(verificationCreationSpy).toHaveBeenCalledTimes(2);
      expect(verificationCreationSpy.mock.calls[1]?.[0]).toMatchObject({
        identifier: expect.stringMatching("jazz-auth-"),
        value: expect.stringContaining('"accountID":"123"'),
      });
    });

    it("should create a new account with jazz auth when using social provider", async () => {
      const signInReq = new Request(
        "http://localhost:3000/api/auth/sign-in/social",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-jazz-auth": JSON.stringify({
              accountID: "123",
              secretSeed: [1, 2, 3],
              accountSecret: "123",
            }),
          },
          body: JSON.stringify({
            provider: providerId,
            callbackURL:
              "http://localhost:3000/api/auth/sign-in/social/callback",
            newUserCallbackURL:
              "http://localhost:3000/api/auth/sign-in/social/callback",
          }),
        },
      );

      const signInRes = await auth.handler(signInReq);
      const signInData = await signInRes.json();

      // Extract cookies from the response
      const cookies = signInRes.headers.getSetCookie();
      const cookieHeader = cookies.join("; ");

      const oauthres = await fetch(signInData.url as string, {
        redirect: "manual",
        headers: cookieHeader ? { cookie: cookieHeader } : {},
      });

      const resURL = new URL(oauthres.headers.get("Location") as string);

      // Pass the cookies to the callback request
      const callbackReq = new Request(resURL);
      if (cookieHeader) {
        callbackReq.headers.set("cookie", cookieHeader);
      }
      const callbackRes = await auth.handler(callbackReq);

      const setCookies = callbackRes.headers.getSetCookie();
      const sessionCookie = setCookies.find((c) =>
        c.includes("better-auth.session_token="),
      );
      expect(sessionCookie).toBeDefined();
      expect(sessionCookie).toMatch("better-auth.session_token=");

      expect(accountCreationSpy).toHaveBeenCalledTimes(1);
      expect(accountCreationSpy).toHaveBeenCalledWith(
        expect.objectContaining({ accountID: "123" }),
        expect.any(Object),
      );
    });
  });

  describe("Email OTP plugin", () => {
    let auth: ReturnType<typeof createAuth>;

    let accountCreationSpy: Mock;
    let verificationCreationSpy: Mock;
    let sendVerificationOTPSpy: Mock;

    const createAuth = () =>
      betterAuth({
        database: memoryAdapter({
          user: [],
          session: [],
          verification: [],
          account: [],
        }),
        plugins: [
          jazzPlugin(),
          emailOTP({
            allowedAttempts: 5,
            otpLength: 6,
            expiresIn: 600,
            sendVerificationOTP: sendVerificationOTPSpy,
          }),
        ],
        emailAndPassword: {
          enabled: true,
          requireEmailVerification: false, // Disable for testing
        },
        databaseHooks: {
          user: {
            create: {
              after: accountCreationSpy,
            },
          },
          verification: {
            create: {
              after: verificationCreationSpy,
            },
          },
        },
      });

    beforeEach(() => {
      accountCreationSpy = vi.fn();
      verificationCreationSpy = vi.fn();
      sendVerificationOTPSpy = vi.fn();
      // Create auth instance with in-memory database
      auth = createAuth();
    });

    it("should create a new account with jazz auth when using email OTP", async () => {
      let OTP: string = "";

      sendVerificationOTPSpy.mockImplementationOnce(({ otp }) => {
        OTP = otp;
      });

      await auth.api.sendVerificationOTP({
        headers: {
          "x-jazz-auth": JSON.stringify({
            accountID: "123",
            secretSeed: [1, 2, 3],
            accountSecret: "123",
          }),
        },
        body: {
          email: "email@email.it",
          type: "sign-in",
        },
      });

      expect(accountCreationSpy).toHaveBeenCalledTimes(0);
      expect(sendVerificationOTPSpy).toHaveBeenCalledTimes(1);
      expect(verificationCreationSpy).toHaveBeenCalledTimes(2);
      expect(verificationCreationSpy.mock.calls[0]?.[0]).toMatchObject(
        expect.objectContaining({
          identifier: "jazz-auth-sign-in-otp-email@email.it",
          value: expect.stringContaining('"accountID":"123"'),
        }),
      );

      await auth.api.signInEmailOTP({
        body: {
          email: "email@email.it",
          otp: OTP,
        },
      });

      expect(accountCreationSpy).toHaveBeenCalledTimes(1);
      expect(accountCreationSpy).toHaveBeenCalledWith(
        expect.objectContaining({ accountID: "123" }),
        expect.any(Object),
      );
    });

    it("should be case-insensitive for email", async () => {
      let OTP: string = "";

      sendVerificationOTPSpy.mockImplementationOnce(({ otp }) => {
        OTP = otp;
      });

      await auth.api.sendVerificationOTP({
        headers: {
          "x-jazz-auth": JSON.stringify({
            accountID: "123",
            secretSeed: [1, 2, 3],
            accountSecret: "123",
          }),
        },
        body: {
          email: "EMAIL@email.it",
          type: "sign-in",
        },
      });

      expect(accountCreationSpy).toHaveBeenCalledTimes(0);
      expect(sendVerificationOTPSpy).toHaveBeenCalledTimes(1);
      expect(verificationCreationSpy).toHaveBeenCalledTimes(2);
      expect(verificationCreationSpy.mock.calls[0]?.[0]).toMatchObject(
        expect.objectContaining({
          identifier: "jazz-auth-sign-in-otp-email@email.it",
          value: expect.stringContaining('"accountID":"123"'),
        }),
      );

      await auth.api.signInEmailOTP({
        body: {
          email: "EMAIL@email.it",
          otp: OTP,
        },
      });

      expect(accountCreationSpy).toHaveBeenCalledTimes(1);
      expect(accountCreationSpy).toHaveBeenCalledWith(
        expect.objectContaining({ accountID: "123" }),
        expect.any(Object),
      );
    });

    it("should not expect Jazz's credentials using Email OTP for sign-in an already registered user", async () => {
      // 1. User registration
      const userData = {
        name: "test",
        email: "test@example.com",
        password: "securePassword123",
      };

      const jazzAuth = {
        accountID: "123",
        secretSeed: [1, 2, 3],
        accountSecret: "123",
        provider: "better-auth",
      };

      await auth.api.signUpEmail({
        body: userData,
        headers: {
          "x-jazz-auth": JSON.stringify(jazzAuth),
        },
      });

      expect(accountCreationSpy).toHaveBeenCalledTimes(1);

      // 2. Try to sign-in with OTP
      let OTP: string = "";

      sendVerificationOTPSpy.mockImplementationOnce(({ otp }) => {
        OTP = otp;
      });

      await auth.api.sendVerificationOTP({
        body: {
          email: "test@example.com",
          type: "sign-in",
        },
      });

      expect(sendVerificationOTPSpy).toHaveBeenCalledTimes(1);
      expect(verificationCreationSpy).toHaveBeenCalledTimes(1);

      const result = await auth.api.signInEmailOTP({
        body: {
          email: "test@example.com",
          otp: OTP,
        },
      });

      expect(accountCreationSpy).toHaveBeenCalledTimes(1); // still only 1
      expect(result).toMatchObject({
        user: {
          id: expect.any(String),
          email: "test@example.com",
          name: "test",
        },
      });
    });
  });
});
