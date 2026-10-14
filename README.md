
<p align="cente">
  <strong>A Minecraft Launcher Designed Around Your Own Experience.</strong>
</p><p align="center">
  A customizable, modern, and user-friendly Minecraft launcher built with Tauri, Vite, Rust, and TypeScript.
</p><p align="center">
  <em>Your instances. Your accounts. Your Minecraft.</em>
</p>---

Table of Contents

- "About the Project" (#about-the-project)
- "Project Vision" (#project-vision)
- "Key Features" (#key-features)
  - "A Unique Design" (#a-unique-design)
  - "Custom Instance Creation" (#custom-instance-creation)
  - "Mod and Modpack Downloads" (#mod-and-modpack-downloads)
  - "Multi-Account Management" (#multi-account-management)
  - "Beginner-Friendly Settings" (#beginner-friendly-settings)
- "Built With" (#built-with)
- "Why Arca-Launcher?" (#why-arca-launcher)
- "Design Philosophy" (#design-philosophy)
- "Supported Platforms and Services" (#supported-platforms-and-services)
- "Installation" (#installation)
- "System Requirements" (#system-requirements)
- "Getting Started" (#getting-started)
- "Project Structure" (#project-structure)
- "Development" (#development)
- "Configuration and Customization" (#configuration-and-customization)
- "Security and Account Management" (#security-and-account-management)
- "Known Limitations" (#known-limitations)
- "Bug Reports and Feedback" (#bug-reports-and-feedback)
- "Roadmap" (#roadmap)
- "Contributing" (#contributing)
- "Acknowledgements" (#acknowledgements)
- "License" (#license)

---

About the Project

Arca-Launcher is a Minecraft launcher project created to provide a different approach to managing and launching Minecraft.

Rather than focusing exclusively on launching the game, Arca-Launcher aims to make the entire experience of organizing, customizing, and managing Minecraft installations more personal and accessible.

The project features a dedicated user interface, a customizable instance creation system, mod and modpack downloads, multi-account management, and settings designed to remain approachable even for users who are not particularly familiar with technical configuration.

Every Minecraft player has a different way of enjoying the game. Some prefer a lightweight vanilla experience, while others enjoy heavily modded environments, large modpacks, or separate installations for different servers and playstyles.

Arca-Launcher is designed with those differences in mind.

Instead of treating every installation as the same environment, Arca-Launcher introduces a more personalized approach to instance management. Each instance can have its own identity through a custom name, description, logo, and background.

The goal is simple: make Minecraft management feel less like configuring software and more like organizing your own collection of experiences.

Arca-Launcher is also the first application developed using the following technology stack:

- Tauri
- Vite
- Rust
- TypeScript

Building this project is an opportunity to explore desktop application development while creating a practical tool for everyday Minecraft use.

Project Vision

Arca-Launcher was created around the idea that a Minecraft launcher should offer more than a button that starts the game.

A good launcher should help players organize their installations, manage their accounts, discover content, and configure their environment without making everything unnecessarily complicated.

The long-term vision of Arca-Launcher is to provide a cohesive launcher experience where customization, functionality, and usability work together.

The project focuses on three main principles:

1. Personalization

Your Minecraft installations should feel like your own.

Arca-Launcher provides a custom instance creation experience where players can define the identity of each instance instead of relying solely on automatically generated names or generic installation entries.

2. Accessibility

Powerful features should not require every user to understand complicated configuration files or manually manage every part of their installation.

Arca-Launcher aims to present its settings and management tools in a way that makes sense to beginners while remaining useful for experienced players.

3. Practical Functionality

Customization is important, but a launcher must also be useful.

Features such as mod downloads, modpack support, and multiple account providers are intended to make everyday Minecraft management more convenient.

These principles guide the development of Arca-Launcher and help establish the direction of the project as it continues to evolve.

---

Key Features

A Unique Design

Arca-Launcher features a dedicated interface designed specifically for the project.

Rather than simply reproducing the appearance of another launcher, the application aims to establish its own visual identity and interaction patterns.

The interface is built to bring its major features together in one environment, allowing users to access their instances, manage accounts, explore available content, and adjust their settings.

The design prioritizes:

- A recognizable visual identity.
- A dedicated experience for managing Minecraft instances.
- Clear navigation between major features.
- An organized presentation of instance information.
- An interface that balances appearance with everyday usability.

The intention is not to make the launcher visually complicated. Instead, the design should make the application feel distinctive without making its functionality difficult to understand.

Custom Instance Creation

One of the defining features of Arca-Launcher is its instance creation system.

An instance represents a separate Minecraft environment that users can organize according to their preferences.

Instead of identifying installations only by their version or mod loader, Arca-Launcher allows users to give each instance a more personal identity.

Each instance supports the following customization options:

Property| Description
Instance Name| Give the instance a recognizable name.
Description| Add information about the instance, its purpose, or its intended playstyle.
Custom Logo| Assign a logo or image that visually identifies the instance.
Custom Background| Personalize the instance with a background image.

This approach makes it easier to distinguish between multiple Minecraft environments.

For example, a player might organize their instances into categories such as:

- Vanilla Survival
- Modded Adventure
- Performance Testing
- Multiplayer
- Modpack Experiments
- Development and Testing

These are examples of possible organizational approaches, not predefined instance categories.

A custom name helps identify an instance quickly. A description provides additional context, while the logo and background make each environment visually distinct.

Together, these options transform instance management from a purely technical task into a more personalized experience.

Mod and Modpack Downloads

Arca-Launcher includes mod and modpack download functionality through two major Minecraft content platforms:

- Modrinth
- CurseForge

These integrations are intended to make discovering and obtaining Minecraft content more convenient from within the launcher.

Instead of requiring users to handle every download manually, Arca-Launcher brings mod and modpack discovery into its broader Minecraft management experience.

Modrinth

Modrinth is a platform for discovering Minecraft mods, modpacks, and other community-created content.

Arca-Launcher integrates Modrinth into its content download functionality, allowing users to access supported content through the launcher.

CurseForge

CurseForge is another major platform for Minecraft mods and modpacks.

Arca-Launcher also provides integration with CurseForge, giving users access to another source of community-created content.

Content Management Goals

The inclusion of both platforms reflects the project's goal of making Minecraft customization more accessible.

By bringing these sources together, Arca-Launcher aims to reduce the need to move between different applications simply to discover or obtain supported content.

Actual content availability, supported download workflows, and compatibility may depend on the relevant platform, Minecraft version, mod loader, and the implementation of each integration.

Users should always review the compatibility information and licensing requirements associated with the content they choose to download.

Multi-Account Management

Arca-Launcher supports managing multiple Minecraft accounts through different account types.

Supported account types include:

- Offline accounts
- Microsoft accounts
- Ely.by accounts

This allows users to organize their account options within the launcher rather than treating account selection as an entirely separate workflow.

Offline Accounts

Offline accounts provide an option for environments that use offline or locally configured player identities.

Offline account functionality does not provide ownership of Minecraft, authenticate a Microsoft account, or grant access to online services that require legitimate authentication.

Server access depends on the server's authentication configuration and applicable Minecraft requirements.

Microsoft Accounts

Arca-Launcher includes Microsoft account support for users who authenticate through Microsoft's account system.

Microsoft authentication is relevant to legitimate Minecraft accounts and associated services.

Account availability and access to particular Minecraft editions or features depend on the account's entitlements and the applicable authentication requirements.

Ely.by Accounts

Arca-Launcher also supports Ely.by accounts, providing another account option for compatible environments and workflows.

The availability of specific Ely.by authentication features depends on the implemented integration and the requirements of the relevant Minecraft environment.

Managing Multiple Accounts

Supporting multiple account types helps accommodate players who use different identities or authentication methods for different environments.

The objective is to keep account selection and management organized while allowing users to choose the appropriate account for their intended Minecraft experience.

Users should keep their credentials secure and use only authentication methods supported by the relevant account provider.

Beginner-Friendly Settings

A launcher can provide many features and still be frustrating if its settings are difficult to understand.

Arca-Launcher aims to keep its configuration experience approachable for users who may not have much technical knowledge.

The goal is to make common configuration tasks understandable without requiring users to learn the internal implementation of the launcher.

The settings experience is guided by several principles:

- Clarity: Settings should communicate their purpose as clearly as possible.
- Accessibility: Common options should be approachable for less experienced users.
- Organization: Related configuration options should be presented logically.
- Usability: The interface should avoid unnecessary complexity.
- Room to grow: More advanced functionality should be introduced without making basic configuration unnecessarily intimidating.

These principles are especially important for users who are new to alternative Minecraft launchers or who simply want to spend more time playing the game.

The objective is to make Arca-Launcher useful without requiring every user to become a technical expert.

---

Built With

Arca-Launcher is developed using a modern desktop application technology stack.

Technology| Role
Tauri| Desktop application framework and native application integration.
Vite| Development server and frontend build tooling.
Rust| Native-side application logic and system integration.
TypeScript| Frontend application logic with static typing.

Tauri

Tauri provides the foundation for packaging the application as a desktop program while connecting the frontend to native functionality.

It enables the project to combine a web-based user interface with native application capabilities.

Vite

Vite provides the frontend development environment and build tooling.

Its development workflow helps make frontend iteration more convenient as the interface and application features evolve.

Rust

Rust is used for native-side functionality.

It provides a foundation for implementing application logic that interacts with the desktop environment and other native capabilities exposed by the project.

TypeScript

TypeScript is used to develop the frontend logic.

Its type system helps make application code easier to reason about and maintain as the project grows.

Why This Technology Stack?

The combination of Tauri, Vite, Rust, and TypeScript allows Arca-Launcher to combine a customizable interface with native desktop functionality.

It also provides an opportunity to explore modern desktop development without building the entire interface and application from the ground up using a traditional native GUI framework.

Arca-Launcher is the first application developed with this particular technology stack, making the project both a practical software project and a learning experience.

---

Why Arca-Launcher?

There are already many Minecraft launchers available, each with its own strengths, design decisions, and target audience.

Arca-Launcher is not intended to suggest that existing launchers are inadequate. Instead, it represents an attempt to build an experience that better reflects the developer's own ideas about interface design, customization, and usability.

The project places particular emphasis on the combination of:

- A dedicated visual identity.
- Personalized instance presentation.
- Access to supported mod and modpack sources.
- Multiple account types.
- Approachable settings.
- A desktop application built with a modern technology stack.

These features form the foundation of the project's identity.

The aim is to create a launcher that feels cohesive rather than like a collection of unrelated utilities.

Arca-Launcher is being developed as a personal project with its own direction, priorities, and design decisions.

Its development is an ongoing process, and its functionality may continue to change as the application matures.

---

Design Philosophy

The design philosophy behind Arca-Launcher can be summarized in one idea:

A launcher should help users organize their experience, not make the experience harder to manage.

Functionality Comes First

A visually appealing interface is valuable, but it should never come at the expense of usability.

Features should serve a purpose, and interface elements should help users understand what they can do.

Personalization Should Feel Natural

Custom logos, backgrounds, descriptions, and instance names give users the freedom to organize their installations in ways that make sense to them.

Customization should feel like a natural part of the experience rather than an unrelated feature.

Complexity Should Be Managed Carefully

Minecraft has many technical components, including game versions, mod loaders, mods, modpacks, account authentication, and different runtime requirements.

Arca-Launcher aims to present relevant functionality in a way that helps users manage these components without overwhelming them.

Development Is an Iterative Process

Arca-Launcher is an actively developed project.

Its interface, features, and internal architecture may evolve as development continues, feedback is received, and technical limitations become better understood.

Not every planned improvement is guaranteed to be implemented, and features may change as the project develops.

---

Supported Platforms and Services

The following table summarizes the technologies and services associated with Arca-Launcher.

Category| Technology or Service
Desktop framework| Tauri
Frontend tooling| Vite
Native programming language| Rust
Frontend language| TypeScript
Mod platform| Modrinth
Modpack platform| CurseForge
Account type| Offline
Account provider| Microsoft
Account provider| Ely.by

The table describes the project's stated technology stack and integrations. It does not guarantee that every operating system, Minecraft version, mod loader, authentication flow, or content type is fully supported.

Refer to the installation instructions and release notes for verified platform compatibility.

---

Installation

«Documentation placeholder: Installation instructions will be added here.»

This section will explain how to obtain Arca-Launcher and install it on supported operating systems.

Planned documentation may include:

- Downloading a stable release.
- Choosing the correct installer or package.
- Installing the application.
- First-launch instructions.
- Troubleshooting installation problems.
- Building the application from source, where supported.

Installation steps and available packages will be documented once the supported distribution methods have been finalized.

For now, refer to the project's official release page or repository for the latest available information.

Release page: [Add the official release URL here]

---

System Requirements

«Documentation placeholder: Verified system requirements will be added here.»

This section will document the minimum and recommended hardware and software requirements for running Arca-Launcher.

Information may include:

- Supported operating systems and versions.
- Processor requirements.
- Memory requirements.
- Storage requirements.
- Graphics and display requirements.
- Runtime or system dependencies.
- Additional requirements for running Minecraft itself.

The requirements for running the launcher may differ from the requirements for running Minecraft.

Minecraft performance depends on the selected game version, installed mods, modpacks, Java runtime, graphics configuration, and the capabilities of the computer.

Minimum requirements: To be determined.

Recommended requirements: To be determined.

Please check the release documentation for confirmed compatibility information before installing the application.

---

Getting Started

After installing Arca-Launcher, users will be able to explore its available features and configure the application according to their preferences.

A general getting-started workflow may include the following steps, depending on the functionality available in the installed version.

1. Open Arca-Launcher

Launch the application and become familiar with its interface.

2. Configure an Account

Choose an available account type, such as an offline account, Microsoft account, or Ely.by account.

Follow the relevant authentication workflow for the selected account type.

3. Create an Instance

Use the instance creation functionality to define a new Minecraft environment.

Customize its name, description, logo, and background according to your preferences.

4. Explore Available Content

Use the supported Modrinth and CurseForge integrations to discover mods or modpacks compatible with your intended Minecraft environment.

Check compatibility information before adding content to an instance.

5. Review Your Settings

Explore the available settings and configure the options relevant to your setup.

The exact workflow may vary depending on the installed release and the features available in that version.

---

Project Structure

Arca-Launcher uses a frontend and native application architecture based on Vite, TypeScript, Tauri, and Rust.

The frontend provides the user interface and its associated application logic, while the native side provides desktop integration and other functionality implemented in Rust.

The exact directory structure may change during development.

A typical Tauri-based project may contain the following components:

Component| Purpose
Frontend source| User interface and TypeScript application logic.
Frontend assets| Images, icons, styles, and other visual resources.
Vite configuration| Frontend development and build configuration.
TypeScript configuration| Type checking and frontend compiler configuration.
Tauri configuration| Desktop application settings and build configuration.
Rust source| Native application logic.
Rust manifest| Native dependencies and build metadata.

This is a conceptual overview rather than an exact representation of the current repository structure.

For an accurate description of individual directories and files, refer to the source code and project configuration.

---

Development

Arca-Launcher is developed with the intention of maintaining a clear separation between frontend presentation and native application functionality.

The development process involves several technologies working together.

Frontend Development

The frontend is written in TypeScript and built with Vite.

This environment supports interface development, application state management, and the integration of frontend functionality with the desktop application.

Native Development

The native side uses Rust and Tauri.

Native functionality can be implemented where desktop integration or system-level operations are required.

Integration

The frontend and native sides work together to provide the complete desktop application.

Features that involve filesystem access, application configuration, downloads, or other native operations may require coordination between these layers, depending on their implementation.

Development Status

Arca-Launcher is an evolving project.

Internal structures, dependencies, configuration options, and supported workflows may change as development progresses.

Contributors and developers working with the source code should review the current project configuration before making architectural changes.

Development instructions, build commands, environment setup, and testing procedures will be documented here as they are finalized.

---

Configuration and Customization

Arca-Launcher aims to provide a balance between personalization and ease of use.

Customization is an important part of the instance management experience, while application settings are intended to remain accessible to users with different levels of technical experience.

Instance Customization

Users can personalize their instances with:

- A custom name.
- A description.
- A logo.
- A background image.

These properties help make instances recognizable and distinguishable from one another.

Application Settings

The application includes a settings experience designed to make configuration approachable.

The exact available settings depend on the current implementation and release.

Detailed documentation for individual settings may be added as the application develops.

Configuration Safety

Users should avoid manually modifying application files or internal configuration data unless they understand the consequences.

Before changing configuration files, consider making a backup of important data.

Configuration locations and supported customization methods should be documented once they have been confirmed for each supported platform.

---

Security and Account Management

Arca-Launcher supports multiple account types, making account handling an important part of the application.

Users should take appropriate precautions when managing their accounts.

Protect Your Credentials

Never share account passwords, access tokens, or other authentication secrets in public bug reports, screenshots, or discussions.

Use Official Authentication Workflows

When using Microsoft or Ely.by accounts, follow the supported authentication workflow and review the relevant provider's account security guidance.

Understand Offline Accounts

Offline account functionality should not be confused with authenticated ownership or authorization.

Access to online servers and Minecraft services depends on their authentication requirements.

Keep Software Updated

Use trusted distribution sources and review release information when updating the launcher.

Report Security Issues Responsibly

If you discover a potential security vulnerability, avoid publishing sensitive exploit details or account information in a public issue.

A dedicated security reporting process can be documented here when one is established.

---

Known Limitations

Arca-Launcher is an evolving software project, and not every aspect of the application may be fully implemented or tested in every environment.

Potential limitations may depend on the installed release, supported operating system, Minecraft version, mod loader, content platform, or authentication provider.

Examples of areas that may require additional verification include:

- Compatibility between mods and Minecraft versions.
- Compatibility between modpacks and their required mod loaders.
- Authentication behavior across different account providers.
- Availability of content from external platforms.
- Operating system-specific behavior.
- Performance and resource usage.
- Incomplete or experimental functionality.

These examples are not a declaration that every listed issue currently exists.

For confirmed limitations and release-specific changes, refer to the project's release notes and issue tracker.

---

Bug Reports and Feedback

«Documentation placeholder: Bug reporting instructions will be added here.»

Feedback is valuable for identifying problems, improving usability, and guiding future development.

If you encounter an issue while using Arca-Launcher, please provide enough information to help reproduce and understand the problem.

When reporting a bug, consider including the following details:

- Operating system: The operating system and version you are using.
- Arca-Launcher version: The version in which the issue occurred.
- Minecraft version: The relevant game version, if applicable.
- Account type: The account type involved, if relevant. Never include credentials or authentication tokens.
- Steps to reproduce: A clear sequence of actions that leads to the issue.
- Expected behavior: What you expected the application to do.
- Actual behavior: What happened instead.
- Error messages: Relevant error messages or logs, with sensitive information removed.
- Additional context: Any other information that may help reproduce the issue.

Suggested Bug Report Template

When a suitable issue tracker is available, you can use the following template.

Title: A short description of the issue.

Environment

- Arca-Launcher version:
- Operating system:
- Minecraft version, if applicable:

Steps to Reproduce

1. Describe the first action.
2. Describe the next action.
3. Explain where the problem occurs.

Expected Behavior

Describe what should have happened.

Actual Behavior

Describe what happened instead.

Additional Information

Include relevant logs, screenshots, or other details. Remove passwords, access tokens, and other sensitive information before sharing.

Issue tracker: [Add the official issue tracker URL here]

Please check existing reports before submitting a new issue, where possible, to reduce duplicate reports.

Constructive suggestions, usability feedback, and feature requests are also welcome through the project's designated feedback channels.

---

Roadmap

Arca-Launcher is a continuing development project. Its direction may evolve as existing features are refined and new ideas are explored.

The following areas represent potential directions based on the project's current goals. They are not promises of specific features or release dates.

Interface and User Experience

- Continue refining the launcher interface.
- Improve navigation and feature discoverability.
- Review the clarity of settings and configuration workflows.
- Refine the presentation of customized instances.

Instance Management

- Continue improving the instance creation experience.
- Review the organization and presentation of instance information.
- Explore additional improvements to instance customization.

Mod and Modpack Support

- Improve the user experience for discovering content.
- Refine supported Modrinth and CurseForge workflows.
- Improve clarity around content compatibility and installation.

Account Management

- Refine the experience of managing multiple account types.
- Improve account selection and related workflows.
- Review authentication error handling and user feedback.

Stability and Maintenance

- Investigate reported bugs.
- Improve error handling and diagnostics.
- Maintain compatibility with supported dependencies.
- Review application performance and reliability.

The priority and availability of these improvements will depend on development progress, technical feasibility, and the needs of the project.

---

Contributing

Arca-Launcher is a personal development project, and its contribution policy may evolve over time.

If the repository accepts external contributions, useful areas of involvement may include:

- Bug reports.
- Reproducible issue investigations.
- Documentation improvements.
- User interface feedback.
- Code contributions.
- Suggestions for improving accessibility and usability.

Before contributing code, review the repository's current contribution guidelines, if available.

When proposing changes, aim to keep them focused, explain their purpose clearly, and avoid introducing unnecessary complexity.

Changes involving authentication, filesystem operations, downloads, or native functionality should be reviewed carefully for security and reliability.

If no formal contribution guidelines have been published, contact the project maintainer through the available official channels before undertaking large changes.

---

Acknowledgements

Arca-Launcher is built on top of technologies and community platforms that make its development and functionality possible.

Special recognition goes to the projects and services associated with its technology stack and content integrations:

- Tauri — For providing the foundation for building desktop applications with web technologies and native functionality.
- Vite — For providing the frontend development and build tooling.
- Rust — For the language and ecosystem used for native application development.
- TypeScript — For bringing static typing to the frontend development process.
- Modrinth — For providing a platform for discovering Minecraft mods and modpacks.
- CurseForge — For providing another major source of Minecraft community content.
- Microsoft — For the account ecosystem used by supported Microsoft authentication workflows.
- Ely.by — For providing an additional account ecosystem supported by the launcher.

Arca-Launcher is an independent project. References to third-party technologies, services, and platforms acknowledge their role in the ecosystem and do not imply endorsement or official affiliation.

All respective names, trademarks, services, and intellectual property remain the property of their respective owners.

---

License

«Documentation placeholder: Add the project's license information here.»

The license determines how the source code may be used, modified, distributed, and incorporated into other projects.

Until a license is explicitly selected and included in the repository, do not assume that the source code is available for unrestricted reuse or redistribution.

License: To be determined.

License file: Add the appropriate "LICENSE" file to the repository once the licensing decision has been finalized.

---

Final Notes

Arca-Launcher is a project built around a simple idea: Minecraft management should be personal, organized, and accessible.

From custom instance identities to mod and modpack downloads and multiple account types, the project aims to bring several everyday Minecraft workflows into a single desktop application.

Developed with Tauri, Vite, Rust, and TypeScript, Arca-Launcher also represents an important step in exploring desktop application development through a modern technology stack.

The project will continue to evolve as its features mature, its limitations become clearer, and its design develops further.

Thank you for taking an interest in Arca-Launcher.

Make your instances yours. Make Minecraft your own.

---

<p align="center">
  <strong>Arca-Launcher</strong>
  <br />
  <em>A launcher with its own identity.</em>
</p>