---
name: Reqnroll BDD Bindings
description: Fill Reqnroll + xUnit step definitions test-first against the system under test
version: 1.0.0
---

# Reqnroll BDD Bindings (xUnit)

Reqnroll is the actively-maintained, open-source successor to SpecFlow. It parses
Gherkin `.feature` files and binds each step to a C# method by matching the step text
against `[Given]/[When]/[Then]` attributes. This skill covers filling those bindings
**test-first**.

## The one rule

The `[Given(@"...")]` attributes in generated `Steps/*.cs` are **authoritative and
read-only**. Bind by editing **method bodies only** — never the attribute text. A
hand-edited attribute that no longer matches the scenario step becomes an *undefined
step*. Wrong/missing attribute text is a drift signal (see
`/ensemble:check-binding-drift`), not something to fix by hand.

## Package set (already wired by the generator)

```xml
<PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1" />
<PackageReference Include="Reqnroll.xUnit" Version="2.1.0" />
<PackageReference Include="xunit" Version="2.9.2" />
<PackageReference Include="xunit.runner.visualstudio" Version="2.8.2" />
<PackageReference Include="FluentAssertions" Version="6.12.1" />
```

`reqnroll.json` sits next to the `.csproj`. The test project references the
system-under-test (SUT) via `<ProjectReference>`.

## Sharing state across Given/When/Then

Use the constructor-injected `ScenarioContext` (Reqnroll creates one per scenario),
or — preferred for typed state — a small context class registered via context
injection:

```csharp
[Binding]
public partial class LoginSteps
{
    private readonly ScenarioContext _ctx;
    public LoginSteps(ScenarioContext ctx) => _ctx = ctx;

    [Given(@"a user with valid credentials")]
    public void GivenAUserWithValidCredentials()
        => _ctx["creds"] = new LoginRequest("a@b.com", "pw");   // arrange

    [When(@"they submit the login form")]
    public async Task WhenTheySubmitTheLoginForm()
        => _ctx["response"] = await _client.PostAsJsonAsync("/api/login", _ctx.Get<LoginRequest>("creds")); // act

    [Then(@"they are authenticated and see the dashboard")]
    public void ThenTheyAreAuthenticatedAndSeeTheDashboard()
        => _ctx.Get<HttpResponseMessage>("response").StatusCode.Should().Be(HttpStatusCode.OK); // assert
}
```

Steps may be `async Task`. Use FluentAssertions (`.Should()`) in Then steps.

## HTTP integration steps

Drive a real ASP.NET Core pipeline with `WebApplicationFactory<Program>` (shared via a
Reqnroll hook / context class), so When steps issue real requests against the SUT.

## Test-first / outside-in workflow

1. Fill a Given/When/Then body to express the interaction against the contract you
   *wish* existed (`IAuthService`, an endpoint, a page object).
2. Build/run — it goes **red** (won't compile → create the interface; then a failing
   assertion). That red is correct: it drives the implementation.
3. Implement the SUT (inner unit-test-first loop) until the scenario is **green**.
4. Never write production logic inside a step body to force a pass; keep steps thin.

If a step can't be bound to a meaningful interaction yet, leave
`throw new PendingStepException();` and report it — a Pending step is honest; a vacuous
passing assertion is not.

## Running

```bash
dotnet test --logger "trx;LogFileName=reqnroll.trx"
dotnet test --filter "@AC-001-1"      # one scenario by tag
```

A `PendingStepException` or "No matching step definition" both mean **red** — the
expected starting state before bindings/implementation exist.
